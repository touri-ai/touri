import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderAdapter, Run, StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { authenticatedSender, bindDeviceSession } from "../../src/kernel/device-session"
import { createLearningReviewer } from "../../src/learning/review"
import { readLearningState, writeLearning } from "../../src/learning/settings"
import { init as initRuntime } from "../../src/runtime"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

test("GET /runs exposes the global work snapshot", async () => {
  const fixture = await getFixture()
  await fixture.engine.shutdown()
  await initRuntime(fixture.runtime.kernel)
  fixture.addCleanup(async () => {
    await fixture.runtime.kernel.services.use("runtime.shutdown")?.()
  })

  const response = await fetch(`http://127.0.0.1:${fixture.runtime.handshake.port}/api/v1/runs`, {
    headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ runs: [], draining: false })
})

test("five bots expose three executing turns and a live FIFO queue, then promote within one second", async () => {
  const fixture = await getFixture()
  const turns = fixture.sendFive()
  await waitFor(() => fixture.getRunning().length === 3)

  const waiting = fixture.engine.getWorkRuns().filter((run) => run.status === "queued")
  expect(waiting.map((run) => [run.id, run.queuePosition, run.queueTotal])).toEqual([
    [turns[3]?.id, 1, 2],
    [turns[4]?.id, 2, 2],
  ])
  const stored = fixture.engine.listRuns("thread-4")[0]
  if (!stored) throw new Error("Missing queued turn snapshot")
  expect(fixture.engine.getRunSnapshot(stored).queuePosition).toBe(2)
  const started = Date.now()
  fixture.finish("thread-0")
  await waitFor(() => fixture.getRunning().some((run) => run.id === turns[3]?.id), 1000)
  await waitFor(() => fixture.getEvent(turns[4]?.id)?.queuePosition === 1, 1000)

  expect(Date.now() - started).toBeLessThan(1000)
  expect(fixture.engine.getWorkRuns()).toHaveLength(4)
  expect(
    fixture
      .getEvents()
      .filter((run) => run.id === turns[4]?.id)
      .at(-1),
  ).toMatchObject({ queuePosition: 1, queueTotal: 1 })
  expect(
    fixture
      .getEvents()
      .filter((run) => run.id === turns[3]?.id)
      .at(-1),
  ).toMatchObject({ queuePosition: null, queueTotal: null })
})

test("canceling a waiting turn republishes the remaining positions without starting the canceled turn", async () => {
  const fixture = await getFixture()
  const turns = fixture.sendFive()
  await waitFor(() => fixture.getRunning().length === 3)
  const canceled = turns[3]
  if (!canceled) throw new Error("Missing queued turn")

  fixture.engine.cancel(canceled.id)
  await waitFor(() => fixture.getEvent(turns[4]?.id)?.queuePosition === 1, 1000)

  expect(fixture.engine.getWorkRuns().filter((run) => run.status === "queued")).toMatchObject([
    { id: turns[4]?.id, queuePosition: 1, queueTotal: 1 },
  ])
  expect(
    fixture
      .getEvents()
      .filter((run) => run.id === turns[4]?.id)
      .at(-1),
  ).toMatchObject({ queuePosition: 1, queueTotal: 1 })
})

test("canceling during preparation ends the turn before the provider can start", async () => {
  const fixture = await getFixture()
  let recalling = false
  fixture.runtime.kernel.services.provide("mem0.api", {
    enabled: () => true,
    instructions: () => null,
    sync: () => {},
    recall: ({ signal }) =>
      new Promise<null>((resolve) => {
        recalling = true
        signal?.addEventListener(
          "abort",
          () => {
            resolve(null)
          },
          { once: true },
        )
      }),
  })
  const run = fixture.send("thread-0")
  await waitFor(() => recalling)

  fixture.engine.cancel(run.id)
  await waitFor(() => fixture.engine.listRuns(run.threadId)[0]?.status === "canceled")

  expect(fixture.getProviderStarts()).toBe(0)
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test("saving concurrency drains immediately, lowering it lets current work finish, and the value survives replacement", async () => {
  const fixture = await getFixture()
  fixture.sendFive()
  await waitFor(() => fixture.getRunning().length === 3)

  expect(await fixture.saveLimit(4)).toBe(200)
  await waitFor(() => fixture.getRunning().length === 4)
  expect(await fixture.saveLimit(1)).toBe(200)
  fixture.finish("thread-0")
  fixture.finish("thread-1")
  fixture.finish("thread-2")
  await waitFor(() => fixture.getRunning().length === 1)

  expect(fixture.engine.getWorkRuns().filter((run) => run.status === "queued")).toHaveLength(1)
  expect(await fixture.saveLimit(0)).toBe(400)
  expect(await fixture.saveLimit(33)).toBe(400)
  await fixture.engine.shutdown()
  const replacement = createRuntimeEngine({
    kernel: fixture.runtime.kernel,
    providerAdapters: { codex: fixture.adapter },
  })
  fixture.addCleanup(() => replacement.shutdown())
  const persisted = fixture.runtime.kernel.services.use("store.settings")?.()

  expect(persisted?.maxConcurrentRuns).toBe(1)
})

test("work snapshots read request origins without loading conversation histories", async () => {
  const fixture = await getFixture()
  fixture.sendFive()
  await waitFor(() => fixture.getRunning().length === 3)
  const store = fixture.runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store unavailable")
  let historyReads = 0
  fixture.runtime.kernel.services.provide("store.api", {
    ...store,
    activePath: (args) => {
      historyReads += 1
      return store.activePath(args)
    },
  })

  const snapshot = fixture.engine.getWorkRuns()

  expect(snapshot).toHaveLength(5)
  expect(historyReads).toBe(0)
})

test("queue positions include turns behind a busy conversation while other conversations can start", async () => {
  const fixture = await getFixture()
  fixture.send("thread-0")
  await waitFor(() => fixture.getRunning().length === 1)

  const blocked = fixture.send("thread-0")
  fixture.send("thread-1")
  await waitFor(() => fixture.getRunning().length === 2)

  expect(fixture.engine.getRunSnapshot(blocked)).toMatchObject({ queuePosition: 1, queueTotal: 1 })
})

test("work snapshots identify routine, delegated and resumed turns and restore queue positions from storage", async () => {
  const fixture = await getFixture()
  const turns = fixture.sendFive()
  await waitFor(() => fixture.getRunning().length === 3)
  const routine = turns[3]
  const resumed = turns[4]
  if (!routine || !resumed) throw new Error("Missing waiting turns")

  expect(fixture.engine.getRunSnapshot(routine).origin).toBe("routine")
  expect(fixture.engine.getRunSnapshot(resumed).origin).toBe("resume")
  expect(fixture.engine.getRunSnapshot(turns[2] ?? resumed).origin).toBe("delegation")
  const waitingIds = fixture.engine
    .getWorkRuns()
    .filter((run) => run.status === "queued")
    .map((run) => run.id)
  await fixture.engine.shutdown()
  const replacement = createRuntimeEngine({
    kernel: fixture.runtime.kernel,
    maxConcurrentRuns: 1,
    providerAdapters: { codex: fixture.adapter },
  })
  fixture.addCleanup(() => replacement.shutdown())

  await replacement.ready
  await waitFor(
    () => replacement.getWorkRuns().length === 5 && replacement.getWorkRuns().some((run) => run.status === "running"),
  )
  const restored = replacement.getWorkRuns().filter((run) => run.status === "queued")

  expect(replacement.getWorkRuns().find((run) => run.status === "running")?.id).toBe(waitingIds[0])
  expect(restored[0]?.id).toBe(waitingIds[1])
  expect(restored.map((run) => run.queuePosition)).toEqual([1, 2, 3, 4])
  expect(restored.every((run) => run.queueTotal === 4)).toBe(true)
  expect(restored.slice(1).map((run) => run.origin)).toEqual(["resume", "resume", "resume"])
})

test.each(["person", "integration"] as const)(
  "%s requests keep message origin in live and persisted work snapshots",
  async (kind) => {
    const fixture = await getFixture()
    const signal = new AbortController().signal
    bindDeviceSession(signal, {
      deviceId: "admin-device",
      person: { id: "owner", name: "Admin", email: null, avatarSeed: "admin", role: "admin" },
      active: () => true,
    })
    const store = fixture.runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Store unavailable")
    const request = store.insertMessage({
      message: {
        id: "human-request",
        threadId: "thread-0",
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Crie um time de demonstração.",
        parts: [],
        sender:
          kind === "integration"
            ? { id: "integration:script", name: "touri avisos", kind }
            : authenticatedSender(signal),
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)

    const result = fixture.engine.enqueue({
      threadId: "thread-0",
      requestMessageId: request.message.id,
      trigger: "user",
    })
    if (!result.success) throw new Error(result.error)
    const persisted = createRuntimePersistence({ database: fixture.runtime.kernel.db })

    expect(fixture.engine.getRunSnapshot(result.run).origin).toBe("message")
    expect(fixture.engine.getWorkRuns().find((run) => run.id === result.run.id)?.origin).toBe("message")
    expect(persisted.getRunSnapshots([result.run.id])[0]?.origin).toBe("message")
  },
)

test("group work preserves execution thread IDs in every event and keeps learning scoped to private chats", async () => {
  const fixture = await getFixture()
  const kernel = fixture.runtime.kernel
  const groups = createGroupStore(kernel)
  const group = groups.save({
    name: "Equipe de demonstração",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-0", "bot-1"],
    coordinatorBotId: null,
  })
  const visible = groups.createThread(group)
  const worker = groups.participant(group, visible.id, "bot-0")
  const reviewer = createLearningReviewer(kernel)
  writeLearning(kernel, "bot-0", { memory: true, memoryEveryTurns: 3 })
  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type === "run.updated") reviewer.onRunFinished(event.run)
  })
  fixture.addCleanup(async () => {
    unsubscribe()
    reviewer.stop()
  })

  const run = fixture.send(worker.id)
  await waitFor(() => fixture.getEvent(run.id)?.status === "running")
  expect(fixture.engine.getWorkRuns().find((candidate) => candidate.id === run.id)).toMatchObject({
    threadId: worker.id,
    groupThreadId: visible.id,
  })
  fixture.finish(worker.id)
  await waitFor(() => fixture.getEvent(run.id)?.status === "succeeded")
  const privateRun = fixture.send("thread-0")
  await waitFor(() => fixture.getEvent(privateRun.id)?.status === "running")
  fixture.finish("thread-0")
  await waitFor(() => fixture.getEvent(privateRun.id)?.status === "succeeded")

  const events = fixture.getEvents().filter((candidate) => candidate.id === run.id)
  expect(new Set(events.map((candidate) => candidate.status))).toEqual(
    new Set(["queued", "starting", "running", "succeeded"]),
  )
  expect(events.every((candidate) => candidate.threadId === worker.id && candidate.groupThreadId === visible.id)).toBe(
    true,
  )
  expect(fixture.engine.listRuns(worker.id)[0]?.threadId).toBe(worker.id)
  expect(readLearningState(kernel, "bot-0").turns).toBe(1)
})

test("one channel message starts one provider and preserves its parent turn in live snapshots", async () => {
  const fixture = await getFixture()
  const startTurn = spyOn(fixture.adapter, "startTurn")
  fixture.addCleanup(async () => startTurn.mockRestore())
  const kernel = fixture.runtime.kernel
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Store unavailable")
  const groups = createGroupStore(kernel)
  const group = groups.save({
    name: "Demo team",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-0"],
    coordinatorBotId: null,
  })
  const channel = groups.createThread(group)
  const request = store.insertMessage({
    message: {
      id: kernel.newId(),
      threadId: channel.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: '@"Equipe 0" Demo task',
      parts: [],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const runtime = createGroupRuntime(kernel, fixture.engine)
  fixture.addCleanup(async () => {
    runtime.shutdown()
    await runtime.waitForDrain()
  })

  const result = runtime.enqueue({ threadId: channel.id, requestMessageId: request.message.id, trigger: "user" })
  if (!result.success) throw new Error(result.error)
  const repeated = runtime.enqueue({ threadId: channel.id, requestMessageId: request.message.id, trigger: "user" })
  await waitFor(() => startTurn.mock.calls.length === 1)
  const work = fixture.engine.getWorkRuns()
  const execution = work[0]
  if (!execution) throw new Error("Missing member execution")

  expect(repeated).toMatchObject({ success: true, run: { id: result.run.id, kind: "coordination" } })
  expect(work).toHaveLength(1)
  expect(execution).toMatchObject({ kind: "execution", groupTurnId: result.run.id, groupThreadId: channel.id })
  expect(fixture.engine.getRunSnapshot(result.run)).toMatchObject({ kind: "coordination" })
  expect(execution.threadId).not.toBe(channel.id)
  expect(runtime.listRuns(channel.id)).toHaveLength(2)
  expect(fixture.getEvent(execution.id)).toMatchObject({ kind: "execution", groupTurnId: result.run.id })
  fixture.finish(execution.threadId)
  await waitFor(() => fixture.getEvent(execution.id)?.status === "succeeded")
  expect(
    fixture.getEvents().some((run) => run.id === execution.id && run.threadId === channel.id && run.groupTurnId),
  ).toBe(true)
  expect(startTurn).toHaveBeenCalledTimes(1)
})

test("channel requests remain visible behind a healthy busy bot and promote without duplicate work", async () => {
  const fixture = await getFixture()
  const kernel = fixture.runtime.kernel
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Store unavailable")
  const groups = createGroupStore(kernel)
  const group = groups.save({
    name: "Demo team",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-0"],
    coordinatorBotId: null,
  })
  const channel = groups.createThread(group)
  const runtime = createGroupRuntime(kernel, fixture.engine)
  fixture.addCleanup(async () => {
    runtime.shutdown()
    await runtime.waitForDrain()
  })
  const send = () => {
    const request = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: channel.id,
        parentId: store.getThread({ threadId: channel.id })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: '@"Equipe 0" Demo task',
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = runtime.enqueue({ threadId: channel.id, requestMessageId: request.message.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)

    return result.run
  }
  const first = send()
  await waitFor(() => fixture.getRunning().length === 1)

  const second = send()
  const third = send()
  const work = fixture.engine.getWorkRuns()
  const execution = work.find((run) => run.groupTurnId === first.id)
  if (!execution) throw new Error("Missing member execution")

  expect(work.map((run) => run.id)).toEqual([execution.id, second.id, third.id])
  expect(work.filter((run) => run.status === "queued")).toMatchObject([
    { id: second.id, kind: "coordination", queuePosition: 1, queueTotal: 2 },
    { id: third.id, kind: "coordination", queuePosition: 2, queueTotal: 2 },
  ])
  expect(fixture.getEvent(second.id)).toMatchObject({ origin: "message", queuePosition: 1, queueTotal: 2 })
  expect(fixture.getProviderStarts()).toBe(1)

  fixture.finish(execution.threadId)
  await waitFor(() => fixture.getRunning().some((run) => run.groupTurnId === second.id))
  const promoted = fixture.engine.getWorkRuns()

  expect(promoted).toHaveLength(2)
  expect(promoted.some((run) => run.id === first.id || run.id === second.id)).toBe(false)
  expect(fixture.getEvent(third.id)).toMatchObject({ queuePosition: 1, queueTotal: 1 })
  expect(fixture.getEvent(second.id)).toMatchObject({ status: "running", origin: "message", queuePosition: null })
})

test("queue publication batches database reads regardless of the number of waiting turns", async () => {
  const fixture = await getFixture(24)
  const turns = Array.from({ length: 24 }, (_, index) => fixture.send(`thread-${index}`))
  await waitFor(() => fixture.getRunning().length === 3)
  const canceled = turns[3]
  const last = turns.at(-1)
  if (!canceled || !last) throw new Error("Missing waiting turns")
  const database = fixture.runtime.kernel.db as Database
  const reads = spyOn(database, "query")
  fixture.addCleanup(async () => {
    reads.mockRestore()
  })

  fixture.engine.cancel(canceled.id)
  await waitFor(() => fixture.getEvent(last.id)?.queueTotal === 20)
  const runReads = reads.mock.calls.filter(([sql]) => /\bFROM runs\b/i.test(sql)).length

  expect(runReads).toBeLessThanOrEqual(12)
  expect(fixture.getEvent(turns[4]?.id)).toMatchObject({ queuePosition: 1, queueTotal: 20 })
  expect(fixture.getEvent(last.id)).toMatchObject({ queuePosition: 20, queueTotal: 20 })
})

test("committed work remains observable while ordered history delivery is deferred", async () => {
  const fixture = await getFixture()
  await fixture.engine.ready
  const database = fixture.runtime.kernel.db as Database
  database.transaction(() => {
    fixture.runtime.kernel.publish({ type: "import.progress", importId: "synthetic", phase: "done", done: 1, total: 1 })
  })()

  const run = fixture.send("thread-0")

  expect(fixture.getEvent(run.id)).toMatchObject({ id: run.id, status: "queued", origin: "message" })
})

const getFixture = async (botCount = 5) => {
  const root = mkdtempSync(join(tmpdir(), "touri-work-queue-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store unavailable")
  Array.from({ length: botCount }, (_, index) => index).forEach((index) => {
    database
      .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,'codex',?,1,1)")
      .run(`bot-${index}`, `Equipe ${index}`, root)
    database
      .query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?,?,?,1,1)")
      .run(`thread-${index}`, `bot-${index}`, `Tarefa ${index}`)
  })
  const completions = new Map<string, () => void>()
  const adapter = getAdapter(completions)
  const engine = createRuntimeEngine({ kernel: runtime.kernel, providerAdapters: { codex: adapter } })
  runtime.kernel.services.provide("runtime.settingsChanged", engine.settingsChanged)
  let events: Run[] = []
  const unsubscribe = (runtime.kernel.subscribeRuntime ?? runtime.kernel.subscribe)(({ event }) => {
    if (event.type === "run.updated") events = [...events, event.run]
  })
  let extraCleanups: Array<() => Promise<void>> = []
  cleanups.add(async () => {
    await engine.shutdown()
    for (const close of extraCleanups) await close()
    unsubscribe()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const send = (threadId: string, index = 0): Run => {
    const part = {
      type: "notice" as const,
      level: "info" as const,
      code: "run_resumed" as const,
      text: "Retomada de teste",
    }
    const request = store.insertMessage({
      message: {
        id: runtime.kernel.newId(),
        threadId,
        parentId: store.getThread({ threadId })?.activeLeafId ?? null,
        role: index === 4 ? "system" : "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Tarefa de demonstração",
        parts: index === 4 ? [part] : [],
        sender: index === 2 ? { id: "bot-0", name: "Equipe 0" } : null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = engine.enqueue({
      threadId,
      requestMessageId: request.message.id,
      trigger: index === 3 ? "routine" : "user",
    })
    if (!result.success) throw new Error(result.error)

    return result.run
  }
  const saveLimit = async (limit: number) => {
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/settings`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ maxConcurrentRuns: limit }),
    })
    return response.status
  }

  return {
    runtime,
    engine,
    adapter,
    send,
    saveLimit,
    sendFive: () => Array.from({ length: 5 }, (_, index) => send(`thread-${index}`, index)),
    getRunning: () => engine.getWorkRuns().filter((run) => run.status === "running"),
    getEvents: () => events,
    getProviderStarts: () => completions.size,
    getEvent: (id: string | undefined) => events.filter((run) => run.id === id).at(-1),
    finish: (threadId: string) => completions.get(threadId)?.(),
    addCleanup: (close: () => Promise<void>) => {
      extraCleanups = [...extraCleanups, close]
    },
  }
}

const getAdapter = (completions: Map<string, () => void>): ProviderAdapter => ({
  provider: "codex",
  detect: async () => ({ success: true, path: "/usr/bin/true", version: "test", loggedIn: true }),
  startTurn: (args: StartTurnArgs) =>
    new Promise<StartTurnResult>((resolve) => {
      const finish = (status: "succeeded" | "interrupted") => {
        if (status === "succeeded") args.onEvent({ type: "text_delta", itemId: "answer", delta: "Tarefa concluída." })
        args.onEvent({ type: "turn_completed", status, errorClass: null, errorMessage: null })
        resolve({ success: true, externalSessionId: `session-${args.thread.id}`, rolloutPath: null, status })
      }
      completions.set(args.thread.id, () => {
        finish("succeeded")
      })
      args.signal.addEventListener(
        "abort",
        () => {
          finish("interrupted")
        },
        { once: true },
      )
      args.onEvent({ type: "turn_started", externalTurnId: `turn-${args.thread.id}` })
    }),
  answerApproval: async () => ({ success: true }),
  shutdown: async () => {},
})

const waitFor = async (predicate: () => boolean, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Work state did not update in time")
    await Bun.sleep(5)
  }
}
