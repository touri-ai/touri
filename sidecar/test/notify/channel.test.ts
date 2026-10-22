import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChannelPerson, Kernel, Message, Run, UiEvent } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupStore } from "../../src/groups/store"
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
  const database = host.kernel.db as Database
  const insertBot = (id: string, name: string, owner = "owner") => {
    database
      .query(
        "INSERT INTO bots(id, name, provider, home_dir, created_at, updated_at, responsible_person_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, "codex", join(root, id), 1, 1, owner)
    const bot = store.getBot({ botId: id })
    if (!bot) throw new Error("Bot fixture missing")

    return bot
  }
  const bot = insertBot("atlas", "Atlas")
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
  const waitForEvent = (isExpected: (event: UiEvent) => boolean) => {
    const delivered = Promise.withResolvers<void>()
    const unsubscribe = host.kernel.subscribe(({ event }) => {
      if (!isExpected(event)) return

      unsubscribe()
      delivered.resolve()
    })
    cleanups.add(async () => unsubscribe())
    return delivered.promise
  }
  return {
    host,
    callHost,
    store,
    bot,
    group,
    thread,
    insert,
    insertBot,
    getNotes: () => notifications.recent(50),
    waitForMessage: () =>
      waitForEvent(
        (event) =>
          (event.type === "message.created" || event.type === "message.updated") &&
          event.message.threadId === thread.id,
      ),
    waitForRun: (id: string) => waitForEvent((event) => event.type === "run.updated" && event.run.id === id),
    flushEvents: () => {
      const delivered = waitForEvent((event) => event.type === "transcript.superseded")
      host.kernel.publish({ type: "transcript.superseded" })
      return delivered
    },
  }
}

test("a person mention alerts only the named channel person with an excerpt and native alert", async () => {
  const fixture = await getFixture()

  const delivered = fixture.waitForMessage()
  fixture.insert("@THIÁGO preciso de você", "ana")
  await delivered

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

test("a known sensitive value is redacted before the mention excerpt is clipped", async () => {
  const fixture = await getFixture()
  const prefix = `@thiago ${"x".repeat(480)}`
  const sensitiveValue = "private-value-".repeat(4)
  fixture.host.kernel.addRedactionValue(sensitiveValue)

  const delivered = fixture.waitForMessage()
  fixture.insert(`${prefix}${sensitiveValue}`, "ana")
  await delivered

  expect(fixture.getNotes()).toMatchObject([{ kind: "mention", body: `${prefix}[REDACTED]` }])
})

test("a bot can mention a person; completed streaming updates and replay notify once", async () => {
  const fixture = await getFixture()
  const started = fixture.waitForMessage()
  const message = fixture.insert("@thiago preciso de você", "bot", "streaming")
  await started
  expect(fixture.getNotes()).toEqual([])

  const completed = fixture.waitForMessage()
  fixture.store.updateMessage({ threadId: fixture.thread.id, messageId: message.id, patch: { status: "complete" } })
  await completed
  fixture.host.kernel.publish({ type: "message.updated", message: { ...message, status: "complete" } })
  await fixture.flushEvents()

  expect(fixture.getNotes()).toMatchObject([
    { kind: "mention", targetPersonId: "owner", botId: fixture.bot.id, title: "@Atlas mencionou você em #mapas" },
  ])
})

test("self mentions, nonmembers, partial names, email addresses and system context stay quiet", async () => {
  const fixture = await getFixture()

  const delivered = fixture.waitForMessage()
  fixture.insert("@thiago @outsider test@Ana @Anabel", "owner")
  await delivered

  expect(fixture.getNotes()).toEqual([])
})

test.each(["user", "routine"] as const)(
  "%s task start alerts the owner and the manual requester once",
  async (trigger) => {
    const fixture = await getFixture()
    const titlePrefix = `Montar mapa ${"x".repeat(98)}`
    const sensitiveValue = "private-\nvalue-".repeat(4)
    fixture.host.kernel.addRedactionValue(sensitiveValue)

    const requestDelivered = fixture.waitForMessage()
    const request = fixture.insert(`${titlePrefix}${sensitiveValue}`, "ana")
    await requestDelivered
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

    const delivered = fixture.waitForRun("retry-run")
    fixture.host.kernel.publish({ type: "run.updated", run })
    fixture.host.kernel.publish({ type: "run.updated", run })
    fixture.host.kernel.publish({ type: "run.updated", run: { ...run, id: "child-run", groupTurnId: run.id } })
    fixture.host.kernel.publish({ type: "run.updated", run: { ...run, id: "retry-run", trigger: "retry" } })
    await delivered

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
          (note) =>
            note.kind === "task-started" &&
            note.title === `Atlas começou uma tarefa em #mapas: ${titlePrefix}[REDACTED]`,
        ),
    ).toBe(true)
  },
)

test("a routine uses its own bot's owner and title even when another bot coordinates the channel", async () => {
  const fixture = await getFixture()
  const routineBot = fixture.insertBot("mapa", "Mapa", "ana")
  const database = fixture.host.kernel.db as Database
  createGroupStore(fixture.host.kernel).save(
    { ...fixture.group, memberIds: [fixture.bot.id, routineBot.id], coordinatorBotId: fixture.bot.id },
    fixture.group,
  )
  const persistence = createRuntimePersistence({ database })
  persistence.saveRoutine({
    id: "map-routine",
    botId: routineBot.id,
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
      runId: null,
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

  const delivered = fixture.waitForRun(run.id)
  fixture.host.kernel.publish({ type: "run.updated", run })
  await delivered

  expect(fixture.getNotes()).toMatchObject([
    { botId: routineBot.id, targetPersonId: "ana", title: "Mapa começou uma tarefa em #mapas: Mapa da manhã" },
  ])
  expect(fixture.getNotes()).toHaveLength(1)
})
