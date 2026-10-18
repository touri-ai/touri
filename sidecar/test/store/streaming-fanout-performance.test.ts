import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  Kernel,
  Message,
  MessagePart,
  ProviderAdapter,
  StartTurnArgs,
  UiEvent,
  UiEventEnvelope,
} from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createPerformanceStageTracker, type PerformanceStageRunner } from "../../src/kernel/performance"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"

// Keep the six-second streaming window opt-in for focused performance measurements.
const HISTORY_MESSAGES = 2_000
const LIVE_TOOL_PARTS = 1_024
const BATCHES = 128
const DELTAS_PER_BATCH = 16
const SAMPLE_MS = 2
const DELTA = "Synthetic streaming output. ".repeat(10)
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

if (process.env.TOURI_STREAMING_BENCH === "1") {
  test.each([1, 3])(
    "%i streaming runs, large threads and two real full-state WebSocket clients",
    async (concurrency) => {
      const fixture = await getFixture(concurrency)
      const expectedText = Array.from({ length: BATCHES }, () => DELTA.repeat(DELTAS_PER_BATCH)).join("\n\n")
      const startedAt = performance.now()
      const probe = getLoopProbe()
      cleanups.add(probe.stop)
      await Bun.sleep(SAMPLE_MS * 2)

      for (const batch of Array.from({ length: BATCHES }, (_, index) => index)) {
        fixture.provider.getTurns().forEach(({ args }) => {
          Array.from({ length: DELTAS_PER_BATCH }, () =>
            args.onEvent({ type: "text_delta", itemId: "reply", delta: DELTA }),
          )
          args.onEvent({ type: "item", part: getTool(batch) })
        })
        fixture.store.flushWrites?.()
        await Bun.sleep(50)
      }
      await getReady(
        () =>
          fixture.clients.every((client) =>
            fixture.threadIds.every((threadId) => client.getReply(threadId)?.text === expectedText),
          ),
        "streaming client state",
      )
      await Bun.sleep(SAMPLE_MS * 2)
      const windowMs = performance.now() - startedAt
      probe.stop()
      const loop = probe.getSnapshot()
      const terminalProbe = getLoopProbe()
      cleanups.add(terminalProbe.stop)
      const terminalStartedAt = performance.now()
      fixture.provider.getTurns().forEach(({ finish }) => {
        finish()
      })
      await getReady(
        () => fixture.threadIds.every((id) => !fixture.engine.activeRun({ threadId: id })),
        "terminal runs",
      )
      await getReady(
        () => fixture.clients.every((client) => client.getCompleted() === concurrency),
        "terminal client state",
      )
      await Bun.sleep(SAMPLE_MS * 2)
      terminalProbe.stop()
      const terminalLoop = terminalProbe.getSnapshot()
      const terminalWindowMs = performance.now() - terminalStartedAt
      const replies = fixture.threadIds.map((threadId) =>
        fixture.store.activePath({ threadId }).find((message) => message.role === "assistant" && message.runId),
      )
      const report = {
        scenario: "active-streaming-full-state-fanout",
        runtime: `Bun ${Bun.version}`,
        platform: process.platform,
        sampleIntervalMs: SAMPLE_MS,
        windowMs,
        concurrency,
        messagesPerThread: HISTORY_MESSAGES,
        toolCallsPerThread: HISTORY_MESSAGES * 5,
        liveToolPartsAtStart: LIVE_TOOL_PARTS,
        historicalPayloadBytes: fixture.historicalPayloadBytes,
        streamedTextBytesPerRun: Buffer.byteLength(expectedText),
        websocketClients: fixture.clients.length,
        batches: BATCHES,
        deltasPerRun: BATCHES * DELTAS_PER_BATCH,
        p99Ms: loop.p99Ms,
        maxMs: loop.maxMs,
        samples: loop.samples,
        terminalWindowMs,
        terminalMaxMs: terminalLoop.maxMs,
        terminalP99Ms: terminalLoop.p99Ms,
        targetMaxMs: 200,
        targetMet: loop.maxMs < 200,
        operations: fixture.metrics.getOperations(),
        clientOperations: fixture.clients.map((client) => client.getOperations()),
      }
      console.info(`streaming-fanout-performance ${JSON.stringify(report)}`)

      expect(replies).toHaveLength(concurrency)
      expect(replies.every((reply) => reply?.text?.startsWith(expectedText))).toBe(true)
      expect(fixture.clients.every((client) => client.getCompleted() === concurrency)).toBe(true)
      expect(fixture.clients.every((client) => client.getDeltaCount() > 0)).toBe(true)
      expect(fixture.clients.every((client) => client.isConnected())).toBe(true)
      fixture.clients.forEach((client) => {
        expect(fixture.threadIds.map((threadId) => client.getReply(threadId)?.text)).toEqual(
          replies.map((reply) => reply?.text),
        )
      })
      expect(fixture.clients.every((client) => client.isContiguous())).toBe(true)
      expect(loop.samples).toBeGreaterThan(0)
      expect(report.targetMet).toBe(true)
    },
    120_000,
  )
}

const getFixture = async (concurrency: number) => {
  const root = await mkdtemp(join(tmpdir(), "touri-streaming-fanout-"))
  const metrics = getStageMetrics()
  const runtime = createKernel({ appData: root, stageTracker: metrics.tracker })
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  cleanups.add(async () => {
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const database = runtime.kernel.db as Database
  await initStore(runtime.kernel, runtime.runStage)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Fixture store missing")

  const threadIds = Array.from({ length: concurrency }, (_, index) => `thread-${index}`)
  const historicalPayloadBytes = await seedHistory(database, root, threadIds)
  let settled = false
  const unsubscribe = runtime.kernel.subscribe(({ event }) => {
    if (event.type === "import.progress" && event.importId === "fixture-ready") settled = true
  })
  runtime.kernel.publish({ type: "import.progress", importId: "fixture-ready", phase: "done", done: 1, total: 1 })
  await getReady(() => settled, "fixture journal delivery")
  unsubscribe()
  const provider = getProvider()
  const kernel: Kernel = Object.assign({}, runtime.kernel, { log: () => {} })
  const engine = createRuntimeEngine({
    kernel,
    runStage: runtime.runStage,
    maxConcurrentRuns: concurrency,
    environment: { PATH: "/usr/bin", HOME: root },
    providerAdapters: { codex: provider.adapter },
  })
  cleanups.add(async () => {
    provider.getTurns().forEach(({ finish }) => {
      finish()
    })
    await engine.shutdown()
  })
  await engine.ready
  const connections = await Promise.allSettled([getClient(runtime.handshake.port), getClient(runtime.handshake.port)])
  const clients = connections.flatMap((connection) => (connection.status === "fulfilled" ? [connection.value] : []))
  cleanups.add(() => {
    clients.forEach((client) => {
      client.close()
    })
  })
  if (clients.length !== 2) throw new Error("Synthetic WebSocket clients unavailable")
  threadIds.forEach((threadId) => {
    const inserted = store.insertMessage({ message: getRequest(threadId) })
    if (!inserted.success) throw new Error("Fixture request missing")

    const queued = engine.enqueue({ threadId, requestMessageId: inserted.message.id, trigger: "user" })
    if (!queued.success) throw new Error("Fixture run unavailable")
  })
  await getReady(() => provider.getTurns().length === concurrency, "provider startup")
  const warmInput = JSON.stringify({ argument: "synthetic".repeat(64) })
  for (const offset of Array.from({ length: LIVE_TOOL_PARTS / 16 }, (_, index) => index * 16)) {
    provider.getTurns().forEach(({ args }) => {
      Array.from({ length: 16 }, (_, index) => offset + index).forEach((index) => {
        args.onEvent({ type: "item", part: Object.assign({}, getTool(-index - 1), { inputJson: warmInput }) })
      })
    })
    await Bun.sleep(1)
  }
  await getReady(
    () =>
      clients.every((client) =>
        threadIds.every((threadId) => client.getReply(threadId)?.parts.length === LIVE_TOOL_PARTS),
      ),
    "live tool warmup",
    () => ({
      parts: clients.map((client) => threadIds.map((threadId) => client.getReply(threadId)?.parts.length)),
      frames: clients.map((client) => client.getOperations().frames),
    }),
  )
  metrics.reset()

  return { store, engine, provider, threadIds, clients, metrics, historicalPayloadBytes }
}

const seedHistory = async (database: Database, root: string, threadIds: string[]): Promise<number> => {
  database
    .query(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic','codex',?,1,1)`)
    .run(root)
  threadIds.forEach((threadId) => {
    database
      .query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?,'bot','Synthetic',1,1)")
      .run(threadId)
  })
  const insert = database.query(`INSERT INTO messages
    (id,thread_id,parent_id,role,kind,status,text,parts_json,created_at,updated_at)
    VALUES (?,?,?,'assistant','text','complete',?,?,?,?)`)
  const text = "Synthetic historical message. ".repeat(128)
  const parts = JSON.stringify(Array.from({ length: 5 }, (_, index) => getTool(index, "synthetic output ".repeat(128))))
  for (const offset of Array.from({ length: Math.ceil(HISTORY_MESSAGES / 32) }, (_, index) => index * 32)) {
    database.transaction(() => {
      threadIds.forEach((threadId) => {
        Array.from({ length: Math.min(32, HISTORY_MESSAGES - offset) }, (_, index) => offset + index).forEach(
          (index) => {
            insert.run(
              `${threadId}-${index}`,
              threadId,
              index ? `${threadId}-${index - 1}` : null,
              text,
              parts,
              index,
              index,
            )
          },
        )
      })
    })()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  return threadIds.length * HISTORY_MESSAGES * (Buffer.byteLength(text) + Buffer.byteLength(parts))
}

const getRequest = (threadId: string): Omit<Message, "createdAt" | "updatedAt"> => ({
  id: `${threadId}-request`,
  threadId,
  parentId: `${threadId}-${HISTORY_MESSAGES - 1}`,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Continue the synthetic task.",
  parts: [{ type: "text", text: "Continue the synthetic task." }],
  sender: null,
  source: "local",
})

const getTool = (index: number, outputJson = "Synthetic result. ".repeat(32)): MessagePart => ({
  type: "tool_call",
  callId: `synthetic-tool-${index}`,
  tool: "synthetic_tool",
  summary: "Synthetic result",
  inputJson: "{}",
  outputJson,
  ok: true,
})

const getProvider = () => {
  let turns: Array<{ args: StartTurnArgs; finish: () => void }> = []
  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/tmp/synthetic-provider", version: "synthetic", loggedIn: true }),
    startTurn: async (args) => {
      if (turns.some(({ args: previous }) => previous.thread.id === args.thread.id))
        return { success: true, externalSessionId: "synthetic", rolloutPath: null, status: "succeeded" }

      const done = Promise.withResolvers<void>()
      const finish = () => done.resolve()
      turns = turns.concat({ args, finish })
      args.signal.addEventListener("abort", finish, { once: true })
      if (args.signal.aborted) finish()
      args.onEvent({ type: "turn_started", externalTurnId: args.thread.id })
      await done.promise
      args.signal.removeEventListener("abort", finish)

      return { success: true, externalSessionId: "synthetic", rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }

  return { adapter, getTurns: () => turns }
}

const getClient = async (port: number) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/ws-ticket`, {
    method: "POST",
    headers: {
      Authorization: "Bearer dev-ui-token",
      Origin: "tauri://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: "/api/v1/events" }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("Synthetic WebSocket ticket unavailable")

  const { ticket } = (await response.json()) as { ticket: string }
  // Bun's native constructor accepts headers beyond the browser constructor's protocol argument.
  const socket: WebSocket = Reflect.construct(WebSocket, [
    `ws://127.0.0.1:${port}/api/v1/events?ticket=${encodeURIComponent(ticket)}`,
    { headers: { Origin: "tauri://localhost" } },
  ])
  let messages: Record<string, Message> = {}
  let frames = 0
  let bytes = 0
  let deltas = 0
  let snapshots = 0
  let parts = 0
  let lastSeq = 0
  let contiguous = true
  const ready = Promise.withResolvers<void>()
  const deadline = setTimeout(() => {
    socket.close()
    ready.reject(new Error("Synthetic WebSocket connection timed out"))
  }, 10_000)
  const onError = () => ready.reject(new Error("Synthetic WebSocket connection failed"))
  socket.addEventListener("error", onError, { once: true })
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data)) as UiEventEnvelope | { type: "resync"; lastSeq: number }
    frames += 1
    bytes += Buffer.byteLength(String(data))
    if (!("event" in frame)) {
      lastSeq = frame.lastSeq
      ready.resolve()
      return
    }
    contiguous = contiguous && frame.seq === lastSeq + 1
    lastSeq = frame.seq
    const event = frame.event
    snapshots += Number(event.type === "message.created" || event.type === "message.updated")
    parts += Number(event.type === "message.parts")
    deltas += Number(event.type === "message.delta")
    messages = getClientMessages(messages, event)
  })
  try {
    await ready.promise
  } catch {
    socket.close()
    throw new Error("Synthetic WebSocket connection unavailable")
  } finally {
    clearTimeout(deadline)
    socket.removeEventListener("error", onError)
  }

  return {
    close: () => socket.close(),
    isConnected: () => socket.readyState === WebSocket.OPEN,
    isContiguous: () => contiguous,
    getCompleted: () =>
      Object.values(messages).filter(
        (message) => message.role === "assistant" && message.runId && message.status === "complete",
      ).length,
    getReply: (threadId: string) =>
      Object.values(messages).find(
        (message) => message.role === "assistant" && message.threadId === threadId && message.runId,
      ),
    getDeltaCount: () => deltas,
    getOperations: () => ({ frames, bytes, deltas, snapshots, parts }),
  }
}

const getStageMetrics = () => {
  const tracker = createPerformanceStageTracker()
  let operations: Record<string, { calls: number; totalMs: number; maxMs: number }> = {}
  const run: PerformanceStageRunner = (stage, action, input) => {
    const startedAt = performance.now()
    try {
      return tracker.run(stage, action, input)
    } finally {
      const elapsed = performance.now() - startedAt
      const previous = operations[stage]
      operations = Object.assign({}, operations, {
        [stage]: {
          calls: (previous?.calls ?? 0) + 1,
          totalMs: (previous?.totalMs ?? 0) + elapsed,
          maxMs: Math.max(previous?.maxMs ?? 0, elapsed),
        },
      })
    }
  }

  return {
    tracker: Object.assign({}, tracker, { run }),
    getOperations: () => operations,
    reset: () => {
      operations = {}
    },
  }
}

type LoopSample = { lagMs: number; previous: LoopSample | null }

const getLoopProbe = () => {
  let previousAt = performance.now()
  let samples: LoopSample | null = null
  let count = 0
  let maxMs = 0
  const timer = setInterval(() => {
    const at = performance.now()
    const lagMs = Math.max(0, at - previousAt - SAMPLE_MS)
    maxMs = Math.max(maxMs, lagMs)
    if (count < 32_768) samples = { lagMs, previous: samples }
    count += 1
    previousAt = at
  }, SAMPLE_MS)

  return {
    stop: () => clearInterval(timer),
    getSnapshot: () => ({
      p99Ms: getQuantile(Array.from(getSampleValues(samples)), 0.99),
      maxMs,
      samples: Math.min(count, 32_768),
    }),
  }
}

function* getSampleValues(sample: LoopSample | null): Generator<number> {
  let current = sample
  while (current) {
    yield current.lagMs
    current = current.previous
  }
}

const getClientMessages = (messages: Record<string, Message>, event: UiEvent): Record<string, Message> => {
  if (event.type === "message.created" || event.type === "message.updated")
    return Object.assign({}, messages, { [event.message.id]: event.message })
  if (event.type !== "message.parts" && event.type !== "message.delta") return messages

  const previous = messages[event.messageId]
  if (!previous) return messages

  const message = event.type === "message.parts" ? getPatchedMessage(previous, event) : getDeltaMessage(previous, event)

  return Object.assign({}, messages, { [event.messageId]: message })
}

const getPatchedMessage = (message: Message, event: Extract<UiEvent, { type: "message.parts" }>): Message => {
  const patches = new Map(event.parts.map((patch) => [patch.partIndex, patch.part]))
  const length = event.parts.reduce((maximum, { partIndex }) => Math.max(maximum, partIndex + 1), message.parts.length)
  const parts = Array.from({ length }, (_, index) => getPart(patches.get(index) ?? message.parts[index]))

  return Object.assign({}, message, { parts })
}

const getDeltaMessage = (message: Message, event: Extract<UiEvent, { type: "message.delta" }>): Message => {
  const part = message.parts[event.partIndex]
  const text = part && "text" in part ? part.text : ""
  const suffix = event.delta.slice(Math.max(0, text.length - (event.offset ?? text.length)))
  const nextPart = Object.assign({}, part, { type: event.partType ?? "text", text: text + suffix }) as MessagePart
  const length = Math.max(message.parts.length, event.partIndex + 1)
  const parts = Array.from({ length }, (_, index) =>
    getPart(index === event.partIndex ? nextPart : message.parts[index]),
  )

  return Object.assign({}, message, { parts, text: nextPart.type === "text" ? message.text + suffix : message.text })
}

const getPart = (part: MessagePart | undefined): MessagePart => {
  if (!part) throw new Error("Synthetic client received a part gap")

  return part
}

const getQuantile = (samples: number[], quantile: number): number => {
  const rank = Math.max(0, Math.ceil(samples.length * quantile) - 1)

  return getValueAtRank(samples, rank)
}

const getValueAtRank = (samples: number[], rank: number): number => {
  const pivot = samples[Math.floor(samples.length / 2)]
  if (pivot === undefined) return 0

  const lower = samples.filter((sample) => sample < pivot)
  if (rank < lower.length) return getValueAtRank(lower, rank)

  const upper = samples.filter((sample) => sample > pivot)
  const through = samples.length - upper.length
  if (rank < through) return pivot

  return getValueAtRank(upper, rank - through)
}

const getReady = async (
  isReady: () => boolean,
  stage: string,
  getDetails: () => unknown = () => null,
): Promise<void> => {
  const deadline = performance.now() + 30_000
  while (!isReady()) {
    if (performance.now() > deadline)
      throw new Error(`Synthetic streaming fixture timed out: ${stage} ${JSON.stringify(getDetails())}`)

    await Bun.sleep(2)
  }
}
