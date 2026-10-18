import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, Message, StartTurnArgs, UiEventEnvelope } from "@touri/contracts"
import { applyDelta, applyParts, updateMessage } from "../../../ui/src/useWorkspace"
import { createKernel } from "../../src/kernel"
import { createEventBus } from "../../src/kernel/event-bus"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
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
  fixture.store.flushWrites?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const before = getMessages(fixture.frames)
  const cursor = fixture.frames.at(-1)?.seq ?? 0

  fixture.engine.cancel(fixture.runId)
  fixture.store.flushWrites?.()
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

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-stream-cancel-"))
  const runtime = getOfflineRuntime(root)
  cleanups.add(async () => {
    runtime.stop()
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
          args.onEvent({ type: "turn_started", externalTurnId: "fixture-turn" })
          ready.resolve(args)
          await finish.promise
          return { success: false, errorCode: "canceled", error: "Canceled" }
        },
        answerApproval: async () => ({ success: true }),
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
    store,
    bus,
    engine,
    frames: first.frames,
    runId: queued.run.id,
    ready: ready.promise,
    finish: finish.resolve,
  }
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
