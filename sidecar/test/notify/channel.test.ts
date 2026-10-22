import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChannelPerson, Kernel, Message, Run } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupStore, routeGroupMessage } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

setDefaultTimeout(20_000)

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

const getPeople = (): ChannelPerson[] => [
  { id: "owner", name: "Você", handle: "thiago", avatarSeed: "owner", role: "admin" },
  { id: "ana", name: "Ana", handle: "Ana", avatarSeed: "ana", role: "member" },
  { id: "ana-maria", name: "Ána Maria", handle: "Ána Maria", avatarSeed: "ana-maria", role: "member" },
]

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-channel-notify-"))
  const host = createKernel({ appData: root })
  cleanups.add(async () => {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  })
  const callHost = mock<Kernel["callHost"]>(async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "Synthetic host",
  }))
  const kernel: Kernel = { ...host.kernel, callHost }
  await initStore(kernel)
  await initGroups(kernel)
  await initNotify(kernel)
  host.kernel.services.provide("work.channelPeople", getPeople)
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const response = await fetch(`http://127.0.0.1:${host.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Atlas", provider: "codex" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Bot fixture failed: ${response.status}`)
  const bot = ((await response.json()) as { bot: { id: string } }).bot
  const groups = createGroupStore(host.kernel)
  const group = groups.save({
    name: "mapas",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  const thread = groups.createThread(group)
  const insert = (text: string, author: "owner" | "ana" | "bot", status: Message["status"] = "complete") => {
    const result = store.insertMessage({
      message: {
        id: host.kernel.newId(),
        threadId: thread.id,
        parentId: null,
        role: author === "bot" ? "assistant" : "user",
        kind: "text",
        status,
        runId: null,
        text,
        parts: [{ type: "text", text }],
        source: "local",
        sender: author === "bot" ? { id: bot.id, name: "Atlas" } : { id: author, name: author, kind: "person" },
      },
    })
    if (!result.success) throw new Error(result.error)

    return result.message
  }
  const notifications = createNotificationStore({ db: host.kernel.db as Database })
  return { host, callHost, store, bot, group, thread, insert, getNotes: () => notifications.recent(50) }
}

test("a person mention alerts only the named channel person with an excerpt and native alert", async () => {
  const fixture = await getFixture()

  fixture.insert("@THIÁGO preciso de você", "ana")

  expect(fixture.callHost).toHaveBeenCalledWith(
    "notify",
    expect.objectContaining({ kind: "mention", onlyWhenUnfocused: true }),
  )
  expect(fixture.getNotes()).toMatchObject([
    {
      kind: "mention",
      targetPersonId: "owner",
      title: "@ana mencionou você em #mapas",
      body: "@THIÁGO preciso de você",
    },
  ])
})

test("a bot can mention a person; completed streaming updates and replay notify once", async () => {
  const fixture = await getFixture()
  const message = fixture.insert("@thiago preciso de você", "bot", "streaming")
  expect(fixture.getNotes()).toEqual([])

  fixture.store.updateMessage({ threadId: fixture.thread.id, messageId: message.id, patch: { status: "complete" } })
  fixture.host.kernel.publish({ type: "message.updated", message: { ...message, status: "complete" } })

  expect(fixture.getNotes()).toMatchObject([
    { kind: "mention", targetPersonId: "owner", botId: fixture.bot.id, title: "@Atlas mencionou você em #mapas" },
  ])
})

test("self mentions, nonmembers, partial names, email addresses and system context stay quiet", async () => {
  const fixture = await getFixture()

  fixture.insert("@thiago @outsider test@Ana @Anabel", "owner")

  expect(fixture.getNotes()).toEqual([])
})

test("a person mention cannot route a bot with a shorter or identical name", async () => {
  const fixture = await getFixture()
  const bots = [{ id: fixture.bot.id, name: "Ana" }]

  expect(routeGroupMessage(fixture.group, bots, "@Ana Maria preciso de você", getPeople())).toEqual([])
  expect(routeGroupMessage(fixture.group, bots, "@Ana preciso de você", getPeople())).toEqual([])
})

test.each(["user", "routine"] as const)(
  "%s task start alerts the owner and the manual requester once",
  async (trigger) => {
    const fixture = await getFixture()
    const request = fixture.insert("Montar mapa", "ana")
    const run: Run = {
      id: "task-run",
      botId: fixture.bot.id,
      threadId: fixture.thread.id,
      provider: "codex",
      trigger,
      requestMessageId: request.id,
      replyMessageId: null,
      requesterPersonId: "ana",
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: trigger === "routine" ? "routine-run" : null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }

    fixture.host.kernel.publish({ type: "run.updated", run })
    fixture.host.kernel.publish({ type: "run.updated", run })

    expect(
      fixture
        .getNotes()
        .map(({ targetPersonId }) => targetPersonId)
        .sort(),
    ).toEqual(trigger === "routine" ? ["owner"] : ["ana", "owner"])
    expect(
      fixture
        .getNotes()
        .every(
          (note) => note.kind === "task-started" && note.title === "Atlas começou uma tarefa em #mapas: Montar mapa",
        ),
    ).toBe(true)
  },
)

test("a routine uses its own bot's owner and title even when another bot coordinates the channel", async () => {
  const fixture = await getFixture()
  const created = await fixture.host.kernel.services.use("bots.create")?.({
    body: { name: "Mapa", provider: "codex" },
    signal: new AbortController().signal,
  })
  if (!created?.success) throw new Error("Routine bot missing")
  const database = fixture.host.kernel.db as Database
  database.query("UPDATE bots SET responsible_person_id = ? WHERE id = ?").run("ana", created.bot.id)
  createGroupStore(fixture.host.kernel).save(
    { ...fixture.group, memberIds: [fixture.bot.id, created.bot.id], coordinatorBotId: fixture.bot.id },
    fixture.group,
  )
  const persistence = createRuntimePersistence({ database })
  persistence.saveRoutine({
    id: "map-routine",
    botId: created.bot.id,
    name: "Mapa da manhã",
    prompt: "Revisar os pontos",
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    continuity: "new-thread",
    resultsThreadId: null,
    groupId: fixture.group.id,
    timeoutMinutes: 10,
    overlap: "skip",
    catchUpMinutes: 10,
    nextRunAt: null,
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  })
  expect(
    persistence.insertRoutineRun({
      id: "map-slot",
      routineId: "map-routine",
      scheduledFor: 1,
      status: "running",
      threadId: fixture.thread.id,
      runId: "map-turn",
      triggerSource: "cron",
      summary: null,
      startedAt: 1,
      finishedAt: null,
    }).success,
  ).toBe(true)
  const run: Run = {
    id: "map-turn",
    botId: fixture.bot.id,
    threadId: fixture.thread.id,
    provider: "codex",
    trigger: "routine",
    requestMessageId: null,
    replyMessageId: null,
    requesterPersonId: "owner",
    externalTurnId: null,
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: "map-slot",
    queuedAt: 1,
    startedAt: 1,
    finishedAt: null,
  }

  fixture.host.kernel.publish({ type: "run.updated", run })

  expect(fixture.getNotes()).toMatchObject([
    { botId: created.bot.id, targetPersonId: "ana", title: "Mapa começou uma tarefa em #mapas: Mapa da manhã" },
  ])
  expect(fixture.getNotes()).toHaveLength(1)
})
