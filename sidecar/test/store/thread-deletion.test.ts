import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Bot, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { init } from "../../src/store"
import { threadDeletionRoutes } from "../../src/store/thread-deletion"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const headers = {
  Authorization: "Bearer dev-ui-token",
  Origin: "tauri://localhost",
  "Content-Type": "application/json",
}

const startFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-thread-delete-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await init(runtime.kernel)
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "mark", provider: "codex", instructions: "Helpful fixture bot." }),
  })
  const { bot } = (await response.json()) as { bot: Bot }
  const db = runtime.kernel.db as Database
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store API missing")
  const createThread = (title: string, options: { groupId?: string; ownerPersonId?: string } = {}): Thread => {
    const result = store.createThread({ botId: bot.id, kind: "chat", title, ...options })
    if (!result.success) throw new Error("Could not create a fixture conversation")
    return result.thread
  }
  const base = `http://127.0.0.1:${runtime.handshake.port}/api/v1`
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  return { bot, createThread, db, request, root, runtime }
}

const waitFor = async (check: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(10)
  }
  throw new Error("Thread deletion did not finish before the test deadline")
}

const getEventLoopProbe = (intervalMs = 5) => {
  let previousAt = performance.now()
  const samples: Array<number> = []
  const timer = setInterval(() => {
    const at = performance.now()
    samples.push(Math.max(0, at - previousAt - intervalMs))
    previousAt = at
  }, intervalMs)

  return {
    stop: () => clearInterval(timer),
    getSamples: () => samples,
  }
}

const getPercentile = (values: Array<number>, percentile: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] ?? 0
}

const getDeletionRoute = (fixture: Awaited<ReturnType<typeof startFixture>>) => {
  fixture.runtime.kernel.services.use("storage.threadDeletion")?.dispose()
  const route = threadDeletionRoutes(fixture.runtime.kernel).find(
    (candidate) => candidate.method === "DELETE" && candidate.path === "/threads/:id",
  )
  if (!route) throw new Error("Thread deletion route missing")
  return route
}

test("DELETE /threads/:id removes transcript, messages, search rows and unused attachments", async () => {
  const fixture = await startFixture()
  const thread = fixture.createThread("Old lead events")
  const unrelatedThread = fixture.createThread("Unrelated conversation")
  const attachmentId = "a".repeat(64)
  const attachmentPath = join(fixture.root, "attachments", attachmentId.slice(0, 2), `${attachmentId}.txt`)
  mkdirSync(join(fixture.root, "attachments", attachmentId.slice(0, 2)), { recursive: true })
  writeFileSync(attachmentPath, "fixture attachment")
  fixture.db
    .query("INSERT INTO attachments(id,path,mime,bytes,origin_path,created_at) VALUES(?,?,?,?,NULL,?)")
    .run(attachmentId, attachmentPath, "text/plain", 17, Date.now())
  fixture.db
    .query(`INSERT INTO messages(id,thread_id,parent_id,role,kind,status,text,parts_json,source,created_at,updated_at)
      VALUES(?,?,NULL,'user','text','complete','lead event',?,'local',1,1)`)
    .run("message-delete", thread.id, JSON.stringify([{ type: "file", attachmentId }]))
  const inserted = fixture.db
    .query("INSERT INTO messages_fts(text,thread_id,message_id) VALUES(?,?,?)")
    .run("lead event", thread.id, "message-delete")
  fixture.db
    .query("INSERT INTO message_search_rows(thread_id,message_id,fts_rowid) VALUES(?,?,?)")
    .run(thread.id, "message-delete", Number(inserted.lastInsertRowid))
  fixture.db
    .query(`INSERT INTO tool_calls(id,thread_id,bot_id,tool,args_json,created_at)
      VALUES('call-delete',?,?, 'read', '{}', 1)`)
    .run(thread.id, fixture.bot.id)
  const notification = fixture.db
    .query(`INSERT INTO notifications(kind,level,bot_id,thread_id,title,body,created_at)
      VALUES('done','info',?,?,'Fixture result','Synthetic result',1)`)
    .run(fixture.bot.id, thread.id)
  fixture.db
    .query("INSERT INTO notification_log(type,notification_id,at) VALUES('notify',?,1)")
    .run(Number(notification.lastInsertRowid))
  fixture.db.query("INSERT INTO ui_event_log(at,event_json) VALUES(?,?)").run(
    Date.now(),
    JSON.stringify({
      type: "message.created",
      message: { threadId: thread.id, parts: [{ type: "file", attachmentId }] },
    }),
  )
  const unrelatedEvent = fixture.db.query("INSERT INTO ui_event_log(at,event_json) VALUES(?,?)").run(
    Date.now(),
    JSON.stringify({
      type: "message.created",
      message: {
        threadId: unrelatedThread.id,
        parts: [{ type: "tool", output: { threadId: thread.id } }],
      },
    }),
  )

  const response = await fixture.request(`/threads/${thread.id}`, "DELETE")
  expect(response.status).toBe(202)
  await waitFor(
    () =>
      !fixture.db.query("SELECT 1 FROM threads WHERE id = ?").get(thread.id) &&
      !fixture.db.query("SELECT 1 FROM thread_deletions WHERE thread_id = ?").get(thread.id),
  )

  expect(fixture.db.query("SELECT 1 FROM messages WHERE thread_id = ?").get(thread.id)).toBeNull()
  expect(fixture.db.query("SELECT 1 FROM transcript_entries WHERE thread_id = ?").get(thread.id)).toBeNull()
  expect(fixture.db.query("SELECT 1 FROM message_search_rows WHERE thread_id = ?").get(thread.id)).toBeNull()
  expect(fixture.db.query("SELECT 1 FROM messages_fts WHERE thread_id = ?").get(thread.id)).toBeNull()
  expect(
    fixture.db.query("SELECT 1 FROM ui_event_log WHERE seq = ?").get(Number(unrelatedEvent.lastInsertRowid)),
  ).not.toBeNull()
  expect(fixture.db.query("SELECT 1 FROM tool_calls WHERE thread_id = ?").get(thread.id)).toBeNull()
  expect(fixture.db.query("SELECT 1 FROM notifications WHERE thread_id = ?").get(thread.id)).toBeNull()
  expect(
    fixture.db
      .query("SELECT 1 FROM notification_log WHERE notification_id = ?")
      .get(Number(notification.lastInsertRowid)),
  ).toBeNull()
  expect(fixture.db.query("SELECT 1 FROM attachments WHERE id = ?").get(attachmentId)).toBeNull()
  expect(existsSync(attachmentPath)).toBe(false)
  expect(fixture.db.query("SELECT delete_before_id, ui_delete_before_seq FROM transcript_maintenance").get()).toEqual({
    delete_before_id: 0,
    ui_delete_before_seq: 0,
  })
})

test("deletion refuses the main conversation and a thread with an active run", async () => {
  const fixture = await startFixture()
  const main = await fixture.request(`/threads/${fixture.bot.mainThreadId}`, "DELETE")
  expect(main.status).toBe(409)
  expect(await main.json()).toMatchObject({ errorCode: "THREAD_MAIN" })

  const active = fixture.createThread("Running conversation")
  fixture.db
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      VALUES('active-delete-run',?,?, 'codex','user','running',?)`)
    .run(active.id, fixture.bot.id, Date.now())
  const response = await fixture.request(`/threads/${active.id}`, "DELETE")
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ errorCode: "THREAD_ACTIVE" })
  expect(fixture.db.query("SELECT 1 FROM thread_deletions WHERE thread_id = ?").get(active.id)).toBeNull()

  const archive = await fixture.request(`/threads/${active.id}`, "PATCH", { archived: true })
  expect(archive.status).toBe(409)
  expect(await archive.json()).toMatchObject({ errorCode: "THREAD_ACTIVE" })
})

test("archived conversations stay out of the active list and appear in the archive list", async () => {
  const fixture = await startFixture()
  const thread = fixture.createThread("Archived conversation")

  const archive = await fixture.request(`/threads/${thread.id}`, "PATCH", { archived: true })
  expect(archive.status).toBe(200)
  expect(((await archive.json()) as { thread: Thread }).thread.archivedAt).toEqual(expect.any(Number))
  const activeList = await fixture.request(`/bots/${fixture.bot.id}/threads`)
  expect(((await activeList.json()) as { threads: Array<Thread> }).threads.map(({ id }) => id)).not.toContain(thread.id)
  const archivedList = await fixture.request(`/bots/${fixture.bot.id}/threads?archived=true`)
  expect(((await archivedList.json()) as { threads: Array<Thread> }).threads.map(({ id }) => id)).toContain(thread.id)

  const unarchive = await fixture.request(`/threads/${thread.id}`, "PATCH", { archived: false })
  expect(unarchive.status).toBe(200)
  const restoredList = await fixture.request(`/bots/${fixture.bot.id}/threads`)
  expect(((await restoredList.json()) as { threads: Array<Thread> }).threads.map(({ id }) => id)).toContain(thread.id)
})

test("bulk deletion accepts 200 ids and rejects more than 200", async () => {
  const fixture = await startFixture()
  const threads = Array.from({ length: 200 }, (_, index) => fixture.createThread(`Old event ${index}`))
  const response = await fixture.request("/threads/delete", "POST", { ids: threads.map((thread) => thread.id) })
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ threadIds: threads.map((thread) => thread.id), phase: "files" })
  await waitFor(
    () =>
      threads.every((thread) => !fixture.db.query("SELECT 1 FROM threads WHERE id = ?").get(thread.id)) &&
      Number((fixture.db.query("SELECT count(*) AS count FROM thread_deletions").get() as { count: number }).count) ===
        0,
    60_000,
  )

  const tooMany = await fixture.request("/threads/delete", "POST", {
    ids: Array.from({ length: 201 }, (_, index) => `thread-${index}`),
  })
  expect(tooMany.status).toBe(400)
  expect(await tooMany.json()).toMatchObject({ errorCode: "INVALID_ARGS" })
})

test("members can delete their own direct conversation but not another conversation in a channel", async () => {
  const fixture = await startFixture()
  fixture.db.query("UPDATE bots SET responsible_person_id = 'member-a' WHERE id = ?").run(fixture.bot.id)
  const own = fixture.createThread("Member conversation", { ownerPersonId: "member-a" })
  const channel = fixture.createThread("Channel conversation")
  fixture.db
    .query(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES('channel-a','Channel','blue','circle','seed',1,1)`)
    .run()
  fixture.db.query("UPDATE threads SET group_id = 'channel-a' WHERE id = ?").run(channel.id)
  const route = getDeletionRoute(fixture)
  const memberSignal = new AbortController().signal
  bindDeviceSession(memberSignal, {
    deviceId: "device-a",
    active: () => true,
    person: { id: "member-a", name: "Member", email: null, avatarSeed: "member-a", role: "member" },
  })
  const invoke = (threadId: string) =>
    route.handler({ params: { id: threadId }, query: {}, body: {}, signal: memberSignal })

  expect(await invoke(channel.id)).toMatchObject({ status: 403, json: { errorCode: "THREAD_DELETE_FORBIDDEN" } })
  expect(await invoke(own.id)).toMatchObject({ status: 202, json: { threadId: own.id } })
})

test("5,000-message deletion returns before cleanup and lets the event loop run", async () => {
  const fixture = await startFixture()
  const thread = fixture.createThread("Large conversation")
  const insert = fixture.db.query(`INSERT INTO messages
    (id,thread_id,parent_id,role,kind,status,text,parts_json,source,created_at,updated_at)
    VALUES(?,?,NULL,'user','text','complete','message','[]','local',?,?)`)
  // The fixture loop runs before the event-loop timing probe, so the probe measures only deletion.
  fixture.db.transaction(() => {
    for (let index = 0; index < 5000; index += 1)
      insert.run(`large-${index.toString().padStart(5, "0")}`, thread.id, index + 1, index + 1)
  })()

  let timerRan = false
  setTimeout(() => {
    timerRan = true
  }, 0)
  const probe = getEventLoopProbe()
  cleanups.add(async () => probe.stop())
  const response = await fixture.request(`/threads/${thread.id}`, "DELETE")

  expect(response.status).toBe(202)
  expect(timerRan).toBe(true)
  expect(fixture.db.query("SELECT count(*) AS count FROM messages WHERE thread_id = ?").get(thread.id)).toEqual({
    count: 5000,
  })
  await waitFor(
    () =>
      !fixture.db.query("SELECT 1 FROM threads WHERE id = ?").get(thread.id) &&
      !fixture.db.query("SELECT 1 FROM thread_deletions WHERE thread_id = ?").get(thread.id),
  )
  probe.stop()
  const timerLags = probe.getSamples()
  expect(timerLags.length).toBeGreaterThan(10)
  expect(getPercentile(timerLags, 0.99)).toBeLessThan(50)
  expect(Math.max(...timerLags)).toBeLessThan(150)
})
