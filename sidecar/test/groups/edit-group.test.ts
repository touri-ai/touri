import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, GroupInput, RunStatus, Thread } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"

// Lifecycle hooks own the disposable servers created by each test.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test.each(["queued", "starting", "running"] as const)(
  "editing metadata and adding members preserves %s work",
  async (status) => {
    const fixture = await getFixture()
    const active = saveRun(fixture, fixture.participant, status)
    const input = {
      ...fixture.input,
      name: "Equipe ampliada",
      color: "#2563eb",
      memberIds: fixture.bots.map((bot) => bot.id),
    }

    const response = await fixture.patch(input)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ group: input })
    expect(fixture.db.query("SELECT status FROM runs WHERE id = ?").get(active)).toEqual({ status })
    expect(fixture.groups.get(fixture.group.id)?.memberIds).toEqual(input.memberIds)
    expect(fixture.store.getThread({ threadId: fixture.participant.id })).not.toBeNull()
  },
)

test.each(["queued", "starting", "running"] as const)(
  "removing a %s member identifies the bot and leaves the edit atomic",
  async (status) => {
    const fixture = await getFixture()
    saveRun(fixture, fixture.participant, status)
    const input = { ...fixture.input, name: "Não salvar", memberIds: [fixture.peer.id] }

    const response = await fixture.patch(input)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      errorCode: "GROUP_MEMBER_BUSY",
      code: "TOURI-E1005",
      busyBotId: fixture.bot.id,
    })
    expect(fixture.groups.get(fixture.group.id)).toEqual(fixture.group)
  },
)

test("removing an idle member succeeds while another member works", async () => {
  const fixture = await getFixture()
  saveRun(fixture, fixture.participant, "running")

  const response = await fixture.patch({ ...fixture.input, memberIds: [fixture.bot.id] })

  expect(response.status).toBe(200)
  expect(fixture.groups.get(fixture.group.id)?.memberIds).toEqual([fixture.bot.id])
})

test("a coordination run's routing identity does not make its idle bot busy", async () => {
  const fixture = await getFixture()
  const participant = fixture.groups.participant(fixture.group, fixture.thread.id, fixture.peer.id)
  saveRun(fixture, participant, "running")

  const response = await fixture.patch({ ...fixture.input, memberIds: [fixture.peer.id] })

  expect(response.status).toBe(200)
})

test.each(["succeeded", "failed", "canceled", "interrupted"] as const)(
  "a %s member can be removed without deleting its history",
  async (status) => {
    const fixture = await getFixture()
    const runId = saveRun(fixture, fixture.participant, status)

    const response = await fixture.patch({ ...fixture.input, memberIds: [fixture.peer.id] })

    expect(response.status).toBe(200)
    expect(fixture.db.query("SELECT status FROM runs WHERE id = ?").get(runId)).toEqual({ status })
    expect(fixture.store.getThread({ threadId: fixture.participant.id })).not.toBeNull()
  },
)

test("work in a private conversation or another group does not block removal here", async () => {
  const fixture = await getFixture()
  const privateThread = fixture.store.getThread({ threadId: fixture.bot.mainThreadId ?? "" })
  if (!privateThread) throw new Error("Missing private conversation")
  const otherGroup = fixture.groups.save({ ...fixture.input, name: "Outro canal" })
  const otherThread = fixture.groups.createThread(otherGroup)
  const otherParticipant = fixture.groups.participant(otherGroup, otherThread.id, fixture.bot.id)
  saveRun(fixture, privateThread, "running")
  saveRun(fixture, otherParticipant, "running")

  const response = await fixture.patch({ ...fixture.input, memberIds: [fixture.peer.id] })

  expect(response.status).toBe(200)
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-edit-group-"))
  const host = createKernel({ appData: root })
  cleanups.push(async () => {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  })
  await initStore(host.kernel)
  await initGroups(host.kernel)
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const request = (path: string, method: string, body: unknown) =>
    fetch(`http://127.0.0.1:${host.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "X-Touri-Client": "edit-group-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  const bots = await Promise.all(
    ["Lia", "Nico", "Bia"].map(async (name): Promise<Bot> => {
      const response = await request("/bots", "POST", { name, provider: "codex" })
      expect(response.status).toBe(201)

      return ((await response.json()) as { bot: Bot }).bot
    }),
  )
  const [bot, peer] = bots
  if (!bot || !peer) throw new Error("Missing members")
  const input: GroupInput = {
    name: "Equipe",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: [bot.id, peer.id],
    coordinatorBotId: null,
  }
  const groups = createGroupStore(host.kernel)
  const group = groups.save(input)
  const thread = groups.createThread(group)
  const participant = groups.participant(group, thread.id, bot.id)
  const fixture = {
    host,
    db: host.kernel.db as Database,
    store,
    groups,
    group,
    thread,
    participant,
    input,
    bots,
    bot,
    peer,
    patch: (input: GroupInput) => request(`/groups/${group.id}`, "PATCH", input),
  }
  saveCoordination(fixture)

  return fixture
}

const saveCoordination = (fixture: {
  host: ReturnType<typeof createKernel>
  db: Database
  thread: Thread
  group: { id: string }
  bot: Bot
}) => {
  const runId = saveRun(fixture, fixture.thread, "running")
  fixture.db
    .query("INSERT INTO group_turns VALUES (?, ?, ?)")
    .run(runId, fixture.group.id, JSON.stringify([fixture.bot.id]))
}

const saveRun = (
  fixture: { host: ReturnType<typeof createKernel>; db: Database },
  thread: Thread,
  status: RunStatus,
) => {
  const runId = fixture.host.kernel.newId()
  fixture.db
    .query(
      "INSERT INTO runs(id, thread_id, bot_id, provider, trigger, status, queued_at) VALUES (?, ?, ?, 'codex', 'user', ?, 1)",
    )
    .run(runId, thread.id, thread.botId, status)

  return runId
}
