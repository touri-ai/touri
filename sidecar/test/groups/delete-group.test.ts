import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, BotGroup, MessagePart, RunStatus, Thread } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { createEventBus } from "../../src/kernel/event-bus"
import { init as initStore } from "../../src/store"
import { deleteBotRoute } from "../../src/vm/delete-bot"
import { createVmRuntime } from "../../src/vm/runtime"
import { fakeVmProvider } from "../vm/fake-provider"

// Bun's lifecycle hooks need a mutable registry for each test's temporary resources.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test("DELETE /groups/:id removes shared, participant and archived history while keeping other conversations", async () => {
  const fixture = await getFixture()
  const participant = fixture.groups.participant(fixture.group, fixture.thread.id, fixture.peer.id)
  const archived = fixture.groups.createThread(fixture.group, "Arquivada")
  const deletedThreads = [fixture.thread, participant, archived]
  const histories = deletedThreads.map((thread) => saveHistory(fixture, thread))
  fixture.db.query("UPDATE threads SET archived_at = 1 WHERE id = ?").run(archived.id)
  const shared = histories[0]
  const child = histories[1]
  if (!shared || !child) throw new Error("Group history missing")
  fixture.db.query("INSERT INTO group_turns VALUES (?, ?, ?)").run(shared.runId, fixture.group.id, "[]")
  fixture.db.query("INSERT INTO group_run_links VALUES (?, ?, 0)").run(child.runId, shared.runId)
  fixture.db
    .query("INSERT INTO group_message_links VALUES (?, ?, ?)")
    .run(child.messageId, participant.id, shared.messageId)
  saveRoutine(fixture, "group-routine", fixture.group.id, fixture.thread.id)
  saveRoutine(fixture, "private-routine", null, fixture.bot.mainThreadId)
  const privateThread = getPrivateThread(fixture, fixture.bot)
  const privateHistory = saveHistory(fixture, privateThread)
  const otherHistory = saveHistory(fixture, fixture.otherThread)

  const response = await fixture.request(`/groups/${fixture.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({})
  expect(fixture.groups.get(fixture.group.id)).toBeNull()
  expect(fixture.db.query("SELECT * FROM group_members WHERE group_id = ?").all(fixture.group.id)).toEqual([])
  expect(fixture.db.query("SELECT * FROM group_turns WHERE group_id = ?").all(fixture.group.id)).toEqual([])
  expect(fixture.db.query("SELECT * FROM group_run_links WHERE turn_id = ?").all(shared.runId)).toEqual([])
  expect(fixture.db.query("SELECT * FROM group_message_links WHERE source_thread_id = ?").all(participant.id)).toEqual(
    [],
  )
  deletedThreads.forEach((thread) => {
    expectDeletedThread(fixture, thread.id)
  })
  histories.forEach(({ runId }) => {
    expect(fixture.db.query("SELECT id FROM runs WHERE id = ?").get(runId)).toBeNull()
  })
  expect(fixture.db.query("SELECT id FROM routines WHERE id = 'group-routine'").get()).toBeNull()
  expect(fixture.db.query("SELECT id FROM routine_runs WHERE routine_id = 'group-routine'").get()).toBeNull()
  expect(fixture.db.query("SELECT id FROM routines WHERE id = 'private-routine'").get()).not.toBeNull()
  expect(fixture.store.getBot({ botId: fixture.bot.id })).not.toBeNull()
  expect(fixture.store.getBot({ botId: fixture.peer.id })).not.toBeNull()
  expect(fixture.groups.get(fixture.otherGroup.id)).not.toBeNull()
  expectRetainedHistory(fixture, privateThread.id, privateHistory)
  expectRetainedHistory(fixture, fixture.otherThread.id, otherHistory)
  expect(fixture.db.query("PRAGMA foreign_key_check").all()).toEqual([])
  expect(fixture.db.query("SELECT delete_before_id, ui_delete_before_seq FROM transcript_maintenance").get()).toEqual({
    delete_before_id: 0,
    ui_delete_before_seq: 0,
  })
})

test("DELETE /groups/:id returns 404 for an unknown group without changing existing groups", async () => {
  const fixture = await getFixture()

  const response = await fixture.request("/groups/missing-group", undefined, "DELETE")

  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ errorCode: "NOT_FOUND" })
  expect(fixture.groups.get(fixture.group.id)).toEqual(fixture.group)
  expect(fixture.store.getThread({ threadId: fixture.thread.id })).not.toBeNull()
})

test("DELETE /groups/:id accepts a group with no remaining members and removes its history", async () => {
  const fixture = await getFixture()
  const history = saveHistory(fixture, fixture.thread)
  fixture.db.query("DELETE FROM group_members WHERE group_id = ?").run(fixture.group.id)
  fixture.db.query("UPDATE bot_groups SET coordinator_bot_id = NULL WHERE id = ?").run(fixture.group.id)
  expect(fixture.groups.get(fixture.group.id)?.memberIds).toEqual([])

  const response = await fixture.request(`/groups/${fixture.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({})
  expect(fixture.groups.get(fixture.group.id)).toBeNull()
  expectDeletedThread(fixture, fixture.thread.id)
  expect(fixture.db.query("SELECT id FROM runs WHERE id = ?").get(history.runId)).toBeNull()
})

test.each([
  ["queued", "shared"],
  ["starting", "shared"],
  ["running", "shared"],
  ["queued", "participant"],
  ["starting", "participant"],
  ["running", "participant"],
] as const)("DELETE /groups/:id preserves a group with a %s run in its %s thread", async (status, kind) => {
  const fixture = await getFixture()
  const thread =
    kind === "shared" ? fixture.thread : fixture.groups.participant(fixture.group, fixture.thread.id, fixture.peer.id)
  const runId = saveRun(fixture, thread, status)

  const response = await fixture.request(`/groups/${fixture.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ errorCode: "GROUP_BUSY" })
  expect(fixture.groups.get(fixture.group.id)).toEqual(fixture.group)
  expect(fixture.store.getThread({ threadId: thread.id })).not.toBeNull()
  expect(fixture.db.query("SELECT status FROM runs WHERE id = ?").get(runId)).toEqual({ status })
})

test("DELETE /groups/:id leaves a member's active private conversation running", async () => {
  const fixture = await getFixture()
  const privateThread = getPrivateThread(fixture, fixture.bot)
  const runId = saveRun(fixture, privateThread, "running")

  const response = await fixture.request(`/groups/${fixture.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(200)
  expect(fixture.db.query("SELECT status FROM runs WHERE id = ?").get(runId)).toEqual({ status: "running" })
  expect(fixture.store.getThread({ threadId: privateThread.id })).not.toBeNull()
})

test("group deletion purges replay copies, advances its floor and forces reconnecting clients to reload", async () => {
  const fixture = await getFixture()
  const participant = fixture.groups.participant(fixture.group, fixture.thread.id, fixture.peer.id)
  fixture.host.kernel.publish({ type: "group.updated", group: fixture.group })
  fixture.host.kernel.publish({
    type: "message.delta",
    threadId: participant.id,
    messageId: "group-replay-message",
    partIndex: 0,
    delta: "deleted-group-history",
  })
  const deletedSeq = getReplaySequence(fixture.db)
  fixture.host.kernel.publish({
    type: "message.delta",
    threadId: fixture.otherThread.id,
    messageId: "retained-replay-message",
    partIndex: 0,
    delta: "retained-group-history",
  })

  const response = await fixture.request(`/groups/${fixture.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(200)
  expect(
    fixture.db.query("SELECT seq FROM ui_event_log WHERE event_json LIKE '%deleted-group-history%'").all(),
  ).toEqual([])
  expect(
    fixture.db
      .query("SELECT seq FROM ui_event_log WHERE json_extract(event_json, '$.group.id') = ?")
      .all(fixture.group.id),
  ).toEqual([])
  expect(
    fixture.db.query("SELECT seq FROM ui_event_log WHERE event_json LIKE '%retained-group-history%'").all(),
  ).toHaveLength(1)
  const floor = fixture.db.query("SELECT value FROM schema_meta WHERE key = 'ui_event_floor_seq'").get() as {
    value: string
  }
  expect(Number(floor.value)).toBeGreaterThanOrEqual(deletedSeq)
  const bus = createEventBus(fixture.db)
  cleanups.push(async () => bus.stop())
  expect(bus.replay(0)[0]?.event.type).toBe("transcript.resync")
})

test("group deletion removes its unused attachments and session artifacts while retaining shared files", async () => {
  const fixture = await getFixture()
  const privateThread = getPrivateThread(fixture, fixture.bot)
  const privateAttachment = saveAttachment(fixture, "group-only")
  const sharedAttachment = saveAttachment(fixture, "shared")
  const unattachedUpload = saveAttachment(fixture, "unused-upload")
  saveMessage(fixture, fixture.thread, "group-files", [getImagePart("group-only"), getImagePart("shared")])
  saveMessage(fixture, privateThread, "private-files", [getImagePart("shared")])
  const groupArtifacts = saveThreadArtifacts(fixture, fixture.thread)
  const privateArtifacts = saveThreadArtifacts(fixture, privateThread)

  const response = await fixture.request(`/groups/${fixture.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(200)
  expect(existsSync(privateAttachment)).toBe(false)
  expect(fixture.db.query("SELECT id FROM attachments WHERE id = 'group-only'").get()).toBeNull()
  expect(existsSync(sharedAttachment)).toBe(true)
  expect(fixture.db.query("SELECT id FROM attachments WHERE id = 'shared'").get()).not.toBeNull()
  expect(existsSync(unattachedUpload)).toBe(true)
  groupArtifacts.forEach((path) => {
    expect(existsSync(path)).toBe(false)
  })
  privateArtifacts.forEach((path) => {
    expect(existsSync(path)).toBe(true)
  })
})

test("deleting a bot refreshes every affected group and clears only that bot's membership and coordinator roles", async () => {
  const fixture = await getFixture()
  const secondGroup = saveGroup(
    fixture.groups,
    "Outro grupo afetado",
    [fixture.peer.id, fixture.bot.id],
    fixture.peer.id,
  )
  fixture.db.query("UPDATE bot_groups SET updated_at = 1").run()
  const retainedGroup = fixture.groups.get(fixture.otherGroup.id)

  const response = await fixture.request(`/bots/${fixture.bot.id}`, { name: fixture.bot.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(fixture.groups.get(fixture.group.id)).toMatchObject({ memberIds: [fixture.peer.id], coordinatorBotId: null })
  expect(fixture.groups.get(secondGroup.id)).toMatchObject({
    memberIds: [fixture.peer.id],
    coordinatorBotId: fixture.peer.id,
  })
  expect(fixture.groups.get(fixture.otherGroup.id)).toEqual(retainedGroup)
  expect(fixture.db.query("SELECT group_id FROM group_members WHERE bot_id = ?").all(fixture.bot.id)).toEqual([])
  expect(fixture.db.query("SELECT id FROM bot_groups WHERE coordinator_bot_id = ?").all(fixture.bot.id)).toEqual([])
  const affectedGroupIds = [fixture.group.id, secondGroup.id]
  affectedGroupIds.forEach((groupId) => {
    const group = fixture.groups.get(groupId)
    expect(group?.updatedAt).toBeGreaterThan(1)
    const event = fixture.db
      .query(
        "SELECT event_json FROM ui_event_log WHERE json_extract(event_json, '$.type') = 'group.updated' AND json_extract(event_json, '$.group.id') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(groupId) as { event_json: string } | null
    expect(event ? JSON.parse(event.event_json) : null).toEqual({ type: "group.updated", group })
  })
})

type Fixture = Awaited<ReturnType<typeof getFixture>>

const getFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-group-delete-"))
  const host = createKernel({ appData: root })
  // Keep automatic maintenance from invalidating the deletion route's attachment scan.
  host.kernel.services.use("storage.maintenance")?.dispose()
  await initStore(host.kernel)
  await initGroups(host.kernel)
  // The host bridge is an external API; inject a successful vault edge for local bot deletion.
  host.kernel.callHost = (async () => ({ success: true, value: {} })) as typeof host.kernel.callHost
  const vm = createVmRuntime({
    kernel: host.kernel,
    provider: fakeVmProvider().provider,
    hostHome: root,
    capability: { available: true, reason: null, provider: "fake" },
    connectionKeys: { rotate: async () => Buffer.alloc(32), remove: async () => {} },
  })
  host.kernel.registerRoutes({ name: "group-delete-test", routes: [deleteBotRoute(host.kernel, vm.service)] })
  cleanups.push(async () => {
    await vm.dispose()
    host.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const request = (path: string, body?: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${host.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "group-delete-test",
        "Content-Type": "application/json",
      },
      body: body === undefined ? null : JSON.stringify(body),
    })
  const createBot = async (name: string): Promise<Bot> => {
    const response = await request("/bots", { name, provider: "codex", machine: "local" })
    expect(response.status).toBe(201)
    return ((await response.json()) as { bot: Bot }).bot
  }
  const bot = await createBot("Planejamento")
  const peer = await createBot("Revisão")
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const groups = createGroupStore(host.kernel)
  const group = saveGroup(groups, "Grupo descartável", [bot.id, peer.id], bot.id)
  const otherGroup = saveGroup(groups, "Grupo preservado", [peer.id], null)
  const thread = groups.createThread(group)
  const otherThread = groups.createThread(otherGroup)

  return {
    root,
    host,
    db: host.kernel.db as Database,
    store,
    groups,
    group,
    otherGroup,
    bot,
    peer,
    thread,
    otherThread,
    request,
  }
}

const saveGroup = (
  groups: ReturnType<typeof createGroupStore>,
  name: string,
  memberIds: string[],
  coordinatorBotId: string | null,
): BotGroup =>
  groups.save({
    name,
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds,
    coordinatorBotId,
  })

const getPrivateThread = (fixture: Fixture, bot: Bot): Thread => {
  const thread = fixture.store.getThread({ threadId: bot.mainThreadId ?? "" })
  if (!thread) throw new Error("Private thread missing")

  return thread
}

const saveRun = (fixture: Fixture, thread: Thread, status: RunStatus = "succeeded") => {
  const runId = fixture.host.kernel.newId()
  fixture.db
    .query(
      "INSERT INTO runs(id, thread_id, bot_id, provider, trigger, status, queued_at) VALUES (?, ?, ?, 'codex', 'user', ?, 1)",
    )
    .run(runId, thread.id, thread.botId, status)

  return runId
}

const saveMessage = (
  fixture: Fixture,
  thread: Thread,
  messageId: string,
  parts: MessagePart[] = [{ type: "text", text: "Histórico de teste" }],
) => {
  const inserted = fixture.store.insertMessage({
    message: {
      id: messageId,
      threadId: thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Histórico de teste",
      parts,
      sender: null,
      source: "local",
    },
  })
  if (!inserted.success) throw new Error(inserted.error)

  return inserted.message
}

const saveHistory = (fixture: Fixture, thread: Thread) => {
  const runId = saveRun(fixture, thread)
  const messageId = fixture.host.kernel.newId()
  saveMessage(fixture, thread, messageId)
  fixture.db
    .query(
      "INSERT INTO send_journal(thread_id, client_nonce, request_json, message_id, deadline, status, run_id, created_at, updated_at) VALUES (?, 'nonce', '{}', ?, 1, 'acked', ?, 1, 1)",
    )
    .run(thread.id, messageId, runId)
  fixture.db
    .query(
      "INSERT INTO tool_resolutions(run_id, call_id, thread_id, part_json, resolution) VALUES (?, 'call', ?, '{}', 'succeeded')",
    )
    .run(runId, thread.id)
  fixture.db.query("INSERT OR REPLACE INTO transcript_retention VALUES (?, 1)").run(thread.id)
  fixture.db.query("INSERT INTO rejections VALUES (?, 1, 1, '{}', 1)").run(thread.id)
  fixture.db
    .query(
      "INSERT INTO notifications(kind, level, bot_id, thread_id, title, body, created_at) VALUES ('info', 'info', ?, ?, 'Teste', 'Histórico de teste', 1)",
    )
    .run(thread.botId, thread.id)
  fixture.db
    .query("INSERT INTO notification_log(type, notification_id, at) VALUES ('notify', last_insert_rowid(), 1)")
    .run()

  return { runId, messageId }
}

const saveRoutine = (fixture: Fixture, id: string, groupId: string | null, threadId: string | null) => {
  fixture.db
    .query(
      "INSERT INTO routines(id, bot_id, name, prompt, cron, timezone, group_id, results_thread_id, created_at, updated_at) VALUES (?, ?, 'Teste', 'Teste', '0 * * * *', 'UTC', ?, ?, 1, 1)",
    )
    .run(id, fixture.bot.id, groupId, threadId)
  fixture.db
    .query(
      "INSERT INTO routine_runs(id, routine_id, scheduled_for, status, thread_id, trigger_source) VALUES (?, ?, 1, 'succeeded', ?, 'manual')",
    )
    .run(`${id}-run`, id, threadId)
}

const expectDeletedThread = (fixture: Fixture, threadId: string) => {
  expect(fixture.store.getThread({ threadId })).toBeNull()
  const tables = [
    "messages",
    "send_journal",
    "tool_resolutions",
    "transcript_entries",
    "transcript_retention",
    "transcript_part_entries",
    "transcript_pending_deltas",
    "rejections",
    "messages_fts",
    "notifications",
    "workspace_message_attention",
  ]
  tables.forEach((table) => {
    expect(fixture.db.query(`SELECT * FROM ${table} WHERE thread_id = ?`).all(threadId)).toEqual([])
  })
  expect(
    fixture.db
      .query("SELECT * FROM notification_log WHERE notification_id NOT IN (SELECT id FROM notifications)")
      .all(),
  ).toEqual([])
}

const expectRetainedHistory = (fixture: Fixture, threadId: string, history: { runId: string; messageId: string }) => {
  expect(fixture.store.getThread({ threadId })).not.toBeNull()
  expect(
    fixture.db.query("SELECT id FROM messages WHERE thread_id = ? AND id = ?").get(threadId, history.messageId),
  ).not.toBeNull()
  expect(fixture.db.query("SELECT id FROM runs WHERE id = ?").get(history.runId)).not.toBeNull()
  expect(fixture.db.query("SELECT message_id FROM messages_fts WHERE thread_id = ?").all(threadId)).toHaveLength(1)
  expect(
    fixture.db.query("SELECT id FROM transcript_entries WHERE thread_id = ?").all(threadId).length,
  ).toBeGreaterThan(0)
  expect(fixture.db.query("SELECT id FROM notifications WHERE thread_id = ?").all(threadId)).toHaveLength(1)
}

const getReplaySequence = (db: Database) =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM ui_event_log").get() as { seq: number }).seq

const saveAttachment = (fixture: Fixture, id: string) => {
  const path = join(fixture.host.kernel.paths.attachmentsDir, `${id}.png`)
  writeFileSync(path, "fake image")
  fixture.db
    .query("INSERT INTO attachments(id, path, mime, bytes, created_at) VALUES (?, ?, 'image/png', 10, 1)")
    .run(id, path)

  return path
}

const getImagePart = (attachmentId: string): MessagePart => ({ type: "image", attachmentId, mime: "image/png" })

const saveThreadArtifacts = (fixture: Fixture, thread: Thread) => {
  const runDirectory = join(fixture.host.kernel.paths.runDir, "claude")
  mkdirSync(runDirectory, { recursive: true })
  const files = ["mcp.json", "settings.json", "system.md"].map((suffix) => join(runDirectory, `${thread.id}.${suffix}`))
  const rollout = join(fixture.host.kernel.paths.sessionsDir, `${thread.id}.jsonl`)
  const paths = files.concat(rollout)
  paths.forEach((path) => {
    writeFileSync(path, "fake session")
  })
  fixture.db
    .query(
      "INSERT INTO provider_sessions(id, thread_id, provider, external_session_id, rollout_path, fingerprint, state, created_at, last_used_at) VALUES (?, ?, 'codex', 'fake-session', ?, 'fake-fingerprint', 'active', 1, 1)",
    )
    .run(`session-${thread.id}`, thread.id, rollout)

  return paths
}
