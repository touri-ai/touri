import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, Message, ProviderAdapter, Run, StartTurnArgs, UiEventEnvelope } from "@touri/contracts"
import { applyDelta, applyParts, updateMessage } from "../../../ui/src/useWorkspace"
import { createKernel } from "../../src/kernel"
import { createEventBus } from "../../src/kernel/event-bus"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { threadDeletionRoutes } from "../../src/store/thread-deletion"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("the first reply word flushes immediately while later chunks remain batched", async () => {
  const fixture = await getFixture()
  const turn = await fixture.ready
  const flush = spyOn(fixture.store, "flushWrites")
  cleanups.add(() => flush.mockRestore())

  turn.onEvent({ type: "text_delta", itemId: "reply", delta: "Olá!" })
  turn.onEvent({ type: "text_delta", itemId: "reply", delta: " Como vai?" })

  expect(flush).toHaveBeenCalledTimes(1)
  await getReady(() => fixture.frames.some(({ event }) => event.type === "message.delta"))
  expect(fixture.engine.listRuns("thread")[0]?.status).toBe("running")
  expect(getReply(getMessages(fixture.frames))?.text).toContain("Olá!")
  fixture.finish()
})

test("mid-stream cancellation preserves buffered text in live sockets, reconnect and journal replay", async () => {
  const fixture = await getFixture()
  const turn = await fixture.ready
  turn.onEvent({ type: "reasoning_delta", itemId: "reasoning", delta: "Conferindo " })
  turn.onEvent({ type: "reasoning_delta", itemId: "reasoning", delta: "os resultados." })
  turn.onEvent({
    type: "item",
    part: {
      type: "tool_call",
      callId: "tool",
      tool: "fixture_tool",
      summary: "Teste",
      inputJson: "{}",
      outputJson: null,
      ok: null,
    },
  })
  turn.onEvent({ type: "text_delta", itemId: "reply", delta: "Resposta " })
  turn.onEvent({ type: "text_delta", itemId: "reply", delta: "parcial preservada." })
  await fixture.store.flushWritesAsync?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const before = getMessages(fixture.frames)
  const cursor = fixture.frames.at(-1)?.seq ?? 0

  fixture.engine.cancel(fixture.runId)
  await fixture.store.flushWritesAsync?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const duringCancel = getMessages(fixture.frames)
  const reconnected = getSocket()
  fixture.bus.add(reconnected.socket, cursor)
  const duringReconnect = getMessages(reconnected.frames, before)
  fixture.finish()
  await getReady(() => fixture.engine.listRuns("thread")[0]?.status === "canceled")
  const live = getMessages(fixture.frames)
  const reconnect = getMessages(reconnected.frames, before)
  const replay = getMessages(fixture.bus.replay(0))
  const durable = fixture.store.activePath({ threadId: "thread" }).find((message) => message.role === "assistant")

  expect(getReply(duringCancel)).toMatchObject({
    text: "Resposta parcial preservada.",
    parts: [
      { type: "reasoning", text: "Conferindo os resultados." },
      { type: "tool_call", resolution: "cancelled_by_user" },
      { type: "text", text: "Resposta parcial preservada." },
    ],
  })
  expect(getReply(duringReconnect)).toEqual(getReply(duringCancel))
  expect(getReply(live)).toMatchObject({ status: "canceled", text: "Resposta parcial preservada." })
  expect(getReply(reconnect)).toEqual(durable)
  expect(getReply(replay)).toEqual(durable)
  expect(getReply(live)).toEqual(durable)
  expect(reconnected.frames.map(({ seq }) => seq)).toEqual(
    Array.from({ length: reconnected.frames.length }, (_, index) => cursor + index + 1),
  )
})

test("deleting a streaming conversation aborts and waits for its provider before purging", async () => {
  const fixture = await getFixture()
  const turn = await fixture.ready
  const canceled = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  turn.signal.addEventListener("abort", () => canceled.resolve(), { once: true })
  fixture.kernel.services.provide("runtime.cancelThreadTurns", async () => {
    await fixture.engine.cancelRuns([fixture.runId])
    settled.resolve()
  })
  fixture.kernel.services.provide("runtime.activeRun", fixture.engine.activeRun)
  fixture.kernel.services.use("storage.threadDeletion")?.dispose()
  const route = threadDeletionRoutes(
    fixture.kernel,
    undefined,
    (threadId) => fixture.store.flushWritesAsync?.({ threadId }) ?? Promise.resolve(),
  ).find(({ method }) => method === "DELETE")
  if (!route) throw new Error("Missing deletion route")
  cleanups.add(() => fixture.kernel.services.use("storage.threadDeletion")?.dispose())

  const response = await route.handler({
    params: { id: "thread" },
    query: {},
    body: {},
    signal: new AbortController().signal,
  })
  await canceled.promise

  expect(response.status).toBe(202)
  expect(turn.signal.aborted).toBe(true)
  expect(fixture.database.query("SELECT 1 FROM threads WHERE id = 'thread'").get()).not.toBeNull()
  fixture.finish()
  await settled.promise
  await getReady(() => !fixture.database.query("SELECT 1 FROM thread_deletions WHERE thread_id = 'thread'").get())
  expect(fixture.database.query("SELECT 1 FROM threads WHERE id = 'thread'").get()).toBeNull()
  expect(fixture.engine.activeRun({ threadId: "thread" })).toBeNull()
})

test("queued work cannot start after its conversation is marked for deletion", async () => {
  const fixture = await getFixture()
  await fixture.ready
  fixture.kernel.services.use("storage.threadDeletion")?.dispose()
  const message = fixture.store.insertMessage({
    message: {
      id: "queued-request",
      threadId: "thread",
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      text: "Outra tarefa sintética.",
      parts: [],
      runId: null,
      sender: null,
      source: "local",
    },
  })
  if (!message.success) throw new Error("Missing queued request")
  const queued = fixture.engine.enqueue({ threadId: "thread", requestMessageId: message.message.id, trigger: "user" })
  if (!queued.success) throw new Error("Could not queue fixture work")
  fixture.database
    .query(
      "INSERT INTO thread_deletions(thread_id,bot_id,phase,created_at,updated_at) VALUES('thread','bot','stopping',1,1)",
    )
    .run()

  fixture.finish()
  await fixture.engine.cancelRuns([fixture.runId])
  await getReady(() => fixture.engine.listRuns("thread").find(({ id }) => id === queued.run.id)?.status === "canceled")

  expect(fixture.getProviderStartCount()).toBe(1)
})

test("a failed stream drain still finalizes the run and releases its thread", async () => {
  const fixture = await getFixture()
  await fixture.ready
  const flushWritesAsync = fixture.store.flushWritesAsync
  if (!flushWritesAsync) throw new Error("Missing asynchronous stream drain")
  fixture.store.flushWritesAsync = async () => {
    throw new Error("Synthetic stream drain failure")
  }
  cleanups.add(() => {
    fixture.store.flushWritesAsync = flushWritesAsync
  })

  fixture.finish()
  await getReady(
    () =>
      fixture.engine.listRuns("thread")[0]?.status === "canceled" &&
      fixture.engine.activeRun({ threadId: "thread" }) === null,
  )

  expect(fixture.engine.listRuns("thread")[0]?.status).toBe("canceled")
})

test("cancel catches a rejected asynchronous finalization", async () => {
  const fixture = await getFixture()
  await fixture.ready
  const log = spyOn(fixture.kernel, "log")
  cleanups.add(() => log.mockRestore())
  const updateThread = fixture.store.updateThread
  fixture.store.updateThread = () => {
    throw new Error("Synthetic finalization failure")
  }
  cleanups.add(() => {
    fixture.store.updateThread = updateThread
  })
  fixture.database
    .query("UPDATE runs SET status = 'queued', provider_started_at = NULL WHERE id = ?")
    .run(fixture.runId)

  expect(fixture.engine.cancel(fixture.runId).success).toBe(true)
  await getReady(() => log.mock.calls.some(([entry]) => entry.msg === "Could not finalize canceled run"))
  fixture.store.updateThread = updateThread
  fixture.finish()
  await getReady(() => fixture.engine.listRuns("thread")[0]?.status === "canceled")

  expect(log.mock.calls.map(([entry]) => entry.msg)).toContain("Could not finalize canceled run")
})

test("startup recovery resolves engine readiness after a stream drain failure", async () => {
  const fixture = await getRecoveryFixture()

  await fixture.engine.ready

  expect(fixture.engine.listRuns("thread")[0]).toMatchObject({ status: "interrupted", errorClass: "app_restart" })
})

test("a late approval response does not recreate completed run state", async () => {
  const answer = Promise.withResolvers<void>()
  const answering = Promise.withResolvers<void>()
  const fixture = await getFixture(async () => {
    answering.resolve()
    await answer.promise
    return { success: true }
  })
  cleanups.add(answer.resolve)
  const turn = await fixture.ready
  turn.onEvent({
    type: "approval_request",
    approvalId: "provider-approval",
    part: {
      type: "approval",
      approvalId: "provider-approval",
      botId: "bot",
      request: "permission",
      detail: "Ação sintética",
      decision: "pending",
      createdAt: 1,
    },
  })
  const approval = fixture.store
    .activePath({ threadId: "thread" })
    .flatMap((message) => message.parts)
    .find((part) => part.type === "approval")
  if (approval?.type !== "approval") throw new Error("Approval missing")

  const response = fixture.engine.answerApproval({ approvalId: approval.approvalId, decision: "approved" })
  await answering.promise
  fixture.finish()
  await getReady(() => fixture.engine.getRetainedRunStateCount() === 0)
  const completed = fixture.store.activePath({ threadId: "thread" })
  answer.resolve()
  const result = await response

  expect(result.success).toBe(true)
  expect(fixture.engine.getRetainedRunStateCount()).toBe(0)
  expect(fixture.engine.listRuns("thread")[0]?.status).toBe("canceled")
  expect(fixture.store.activePath({ threadId: "thread" })).toEqual(completed)
})

const getMessages = (frames: UiEventEnvelope[], initial: Message[] = []): Message[] =>
  frames.reduce((messages, { event }) => {
    if (event.type === "message.created" || event.type === "message.updated")
      return updateMessage(messages, event.message)
    if (event.type === "message.parts") {
      const updated = applyParts(messages, event)
      messages.forEach((message) => {
        message.parts.forEach((part, index) => {
          if (part.type !== "text" && part.type !== "reasoning") return
          const next = updated.find((candidate) => candidate.id === message.id)?.parts[index]
          if (next && "text" in next) expect(next.text.length).toBeGreaterThanOrEqual(part.text.length)
        })
      })
      return updated
    }
    if (event.type !== "message.delta") return messages
    const part = messages.find((message) => message.id === event.messageId)?.parts[event.partIndex]
    expect(event.offset ?? 0).toBeLessThanOrEqual(part && "text" in part ? part.text.length : 0)
    return applyDelta(messages, event.messageId, event.delta, event.partIndex, event.offset, event)
  }, initial)

const getReply = (messages: Message[]) => messages.find((message) => message.role === "assistant")

const getSocket = () => {
  const frames: UiEventEnvelope[] = []
  return {
    frames,
    socket: {
      readyState: 1 as const,
      sendText: (payload: string) => {
        const frame = JSON.parse(payload)
        if ("event" in frame) frames.push(frame)
        return payload.length
      },
    },
  }
}

const getFixture = async (answerApproval: ProviderAdapter["answerApproval"] = async () => ({ success: true })) => {
  const root = await mkdtemp(join(tmpdir(), "touri-stream-cancel-"))
  const runtime = getOfflineRuntime(root)
  cleanups.add(async () => {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','codex',?,1,1)")
    .run(root)
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Conversa',1,1)")
  const bus = createEventBus(database)
  cleanups.add(bus.stop)
  const kernel: Kernel = { ...runtime.kernel, publish: bus.publish, subscribe: bus.subscribe }
  await initStore(kernel)
  const first = getSocket()
  bus.add(first.socket)
  bus.add(getSocket().socket)
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const created = store.insertMessage({
    message: {
      id: "request",
      threadId: "thread",
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Confira o resultado.",
      parts: [],
      sender: null,
      source: "local",
    },
  })
  if (!created.success) throw new Error(created.error)
  // Count adapter calls to verify that deleted queued work never starts.
  let providerStartCount = 0
  const ready = Promise.withResolvers<StartTurnArgs>()
  const finish = Promise.withResolvers<void>()
  const engine = createRuntimeEngine({
    kernel,
    environment: { PATH: "/usr/bin", HOME: root },
    providerAdapters: {
      codex: {
        provider: "codex",
        detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
        startTurn: async (args) => {
          providerStartCount += 1
          args.onEvent({ type: "turn_started", externalTurnId: "fixture-turn" })
          ready.resolve(args)
          await finish.promise
          return { success: false, errorCode: "canceled", error: "Canceled" }
        },
        answerApproval,
        shutdown: async () => {
          finish.resolve()
        },
      },
    },
  })
  cleanups.add(() => {
    finish.resolve()
    return engine.shutdown()
  })
  const queued = engine.enqueue({ threadId: "thread", requestMessageId: "request", trigger: "user" })
  if (!queued.success) throw new Error(queued.error)
  return {
    kernel,
    database,
    store,
    bus,
    engine,
    frames: first.frames,
    runId: queued.run.id,
    ready: ready.promise,
    getProviderStartCount: () => providerStartCount,
    finish: finish.resolve,
  }
}

const getRecoveryFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-stream-recovery-"))
  const runtime = getOfflineRuntime(root)
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Synthetic','codex',?,1,1)")
    .run(root)
  database.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    INSERT INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1);`)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const request = store.insertMessage({
    message: {
      id: "request",
      threadId: "thread",
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Synthetic request",
      parts: [],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const now = Date.now()
  const run: Run = {
    id: "recovered-run",
    botId: "bot",
    threadId: "thread",
    provider: "codex",
    trigger: "user",
    requestMessageId: request.message.id,
    replyMessageId: null,
    externalTurnId: null,
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: now - 1_000,
    startedAt: now - 1_000,
    finishedAt: null,
  }
  createRuntimePersistence({ database }).saveRun(run)
  const flushWritesAsync = store.flushWritesAsync
  if (!flushWritesAsync) throw new Error("Missing asynchronous stream drain")
  store.flushWritesAsync = async () => {
    throw new Error("Synthetic stream drain failure")
  }
  const engine = createRuntimeEngine({ kernel: runtime.kernel })
  cleanups.add(async () => {
    store.flushWritesAsync = flushWritesAsync
    await engine.shutdown()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  return { engine }
}

const getOfflineRuntime = (root: string) => {
  const serve = spyOn(Bun, "serve").mockReturnValue({ port: 0, stop: () => {} } as ReturnType<typeof Bun.serve>)
  try {
    return createKernel({ appData: root })
  } finally {
    serve.mockRestore()
  }
}

const getReady = async (ready: () => boolean): Promise<void> => {
  const deadline = performance.now() + 5_000
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("Fixture cancellation did not finish")
    await Bun.sleep(2)
  }
}
