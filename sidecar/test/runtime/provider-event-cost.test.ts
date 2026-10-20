import type { Database } from "bun:sqlite"
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createKernel } from "../../src/kernel"
import type { PerformanceStage, PerformanceStageRunner, PerformanceStageTracker } from "../../src/kernel/performance"
import { createPerformanceStageTracker } from "../../src/kernel/performance"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"
import { fakeProviderSpawn } from "../fakes/provider-spawn"

setDefaultTimeout(60_000)
let replayCleanups: Array<() => void | Promise<void>> = []

const runReplayCleanups = async (cleanups: Array<() => void | Promise<void>>): Promise<void> => {
  const [cleanup, ...remaining] = cleanups
  if (!cleanup) return
  await runReplayCleanups(remaining)
  await cleanup()
}

afterEach(async () => {
  const cleanups = replayCleanups
  replayCleanups = []
  await runReplayCleanups(cleanups)
})

type BenchmarkStage = {
  name: PerformanceStage
  calls: number
  totalMs: number
  maxMs: number
  dispatchCalls: number
  dispatchMs: number
  dispatchSelfMs: number
}

type BenchmarkResult = {
  events: number
  historyMessages: number
  historyPartBytes: number
  parts: number
  replyDigest: string
  providerCpuMs: number
  providerDispatchMs: number
  providerAdapterMs: number
  providerDispatchAttribution: number
  streamingReply: boolean
  runtimeEventMs: number
  providerDispatchCalls: number
  runtimeEventCalls: number
  attributedMs: number
  attributedCpuMs: number
  maxBlockMs: number
  maxTimerLagMs: number
  p99TimerLagMs: number
  timerWindowMs: number
  timerSamples: number
  maxBlockCpuMs: number
  p95BlockCpuMs: number
  blockCpuSamples: number
  duplicateSharesRun: boolean
  duplicateActiveRuns: number
  retainedRunStates: number
  busEvents: number
  busPartsEvents: number
  stages: Array<BenchmarkStage>
}

const getReplayEvents = (count: number): Array<Record<string, unknown>> => {
  const toolCount = Math.floor(count * 0.1167)
  const commandCount = Math.floor(count * 0.0224)
  const completionCount = Math.floor(count / 3)
  const textCount = Math.floor((count - toolCount - commandCount * 2 - completionCount) / 2)
  const reasoningCount = count - toolCount - commandCount * 2 - completionCount - textCount

  return [
    ...Array.from({ length: toolCount }, (_, index) => ({
      method: "item/started",
      params: { item: { id: `tool-${index}`, type: "mcpToolCall", tool: "lookup", input: { index } } },
    })),
    ...Array.from({ length: commandCount }, (_, index) => ({
      method: "item/started",
      params: {
        item: {
          id: `command-${index}`,
          type: "commandExecution",
          command: "echo sample",
          cwd: "/workspace",
          exitCode: null,
        },
      },
    })),
    ...Array.from({ length: commandCount }, (_, index) => ({
      method: "item/commandExecution/outputDelta",
      params: { itemId: `command-${index}`, delta: "sample output\n" },
    })),
    ...Array.from({ length: completionCount }, (_, index) => {
      const itemIndex = toolCount - 1 - (index % toolCount)
      return {
        method: "item/completed",
        params: {
          item: {
            id: `tool-${itemIndex}`,
            type: "mcpToolCall",
            tool: "lookup",
            status: "completed",
            output: { found: true },
          },
        },
      }
    }),
    ...Array.from({ length: textCount }, (_, index) => ({
      method: "item/agentMessage/delta",
      params: { itemId: "answer", delta: `x${index % 10}` },
    })),
    ...Array.from({ length: reasoningCount }, (_, index) => ({
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "reasoning", delta: `r${index % 10}` },
    })),
    { type: "complete" },
  ]
}

const getPercentile = (samples: Array<number>, fraction: number): number => {
  const sorted = Array.from(samples).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

const getTrackedRunner = (now = performance.now.bind(performance)) => {
  const tracker = createPerformanceStageTracker(now)
  // Synchronous span bookkeeping is local to this recorder; children charge only their direct parent.
  let activeSpan: { childMs: number; inDispatch: boolean } | null = null
  let attributedMs = 0
  let attributedCpuMs = 0
  let maxBlockMs = 0
  let maxBlockCpuMs = 0
  const blockCpuSamples: Array<number> = []
  // Each replay keeps bounded timer samples and cancels its probe during teardown.
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextTimerAt = 0
  let maxTimerLagMs = 0
  let timerStartedAt: number | null = null
  let timerSamples = 0
  const timerLagSamples: Array<number> = []
  const sampleTimer = (): void => {
    const lagMs = Math.max(0, performance.now() - nextTimerAt)
    maxTimerLagMs = Math.max(maxTimerLagMs, lagMs)
    timerSamples += 1
    if (timerLagSamples.length < 10_000) timerLagSamples.push(lagMs)
  }
  const scheduleTimer = (): void => {
    nextTimerAt = performance.now() + 1
    timer = setTimeout(() => {
      sampleTimer()
      scheduleTimer()
    }, 1)
  }
  const stopProbe = (): void => {
    if (timer === null) return
    sampleTimer()
    clearTimeout(timer)
    timer = null
  }
  let firstFrameCpu: NodeJS.CpuUsage | null = null
  const stageTimes = new Map<PerformanceStage, BenchmarkStage>()
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    if (stage === "provider_frame_batch" && firstFrameCpu === null) {
      firstFrameCpu = process.cpuUsage()
      timerStartedAt = performance.now()
      scheduleTimer()
    }
    const parent = activeSpan
    const span = { childMs: 0, inDispatch: stage === "provider_frame_dispatch" || (parent?.inDispatch ?? false) }
    const cpuStartedAt = parent === null && firstFrameCpu !== null ? process.cpuUsage() : null
    activeSpan = span
    const startedAt = now()
    try {
      return tracker.run(stage, action, input)
    } finally {
      const elapsed = now() - startedAt
      activeSpan = parent
      if (parent) parent.childMs += elapsed
      const previous = stageTimes.get(stage)
      stageTimes.set(stage, {
        name: stage,
        calls: (previous?.calls ?? 0) + 1,
        totalMs: (previous?.totalMs ?? 0) + elapsed,
        maxMs: Math.max(previous?.maxMs ?? 0, elapsed),
        dispatchCalls: (previous?.dispatchCalls ?? 0) + (span.inDispatch ? 1 : 0),
        dispatchMs: (previous?.dispatchMs ?? 0) + (span.inDispatch ? elapsed : 0),
        dispatchSelfMs: (previous?.dispatchSelfMs ?? 0) + (span.inDispatch ? elapsed - span.childMs : 0),
      })
      if (parent === null && firstFrameCpu !== null) {
        // One-time end-of-turn work is budgeted separately; the block budget covers streaming.
        const streaming = stage !== "runtime_turn_finalization"
        attributedMs += elapsed
        if (streaming) maxBlockMs = Math.max(maxBlockMs, elapsed)
        if (cpuStartedAt) {
          const cpu = process.cpuUsage(cpuStartedAt)
          const blockCpuMs = (cpu.user + cpu.system) / 1_000
          attributedCpuMs += blockCpuMs
          if (streaming) {
            maxBlockCpuMs = Math.max(maxBlockCpuMs, blockCpuMs)
            blockCpuSamples.push(blockCpuMs)
          }
        }
      }
    }
  }
  const stageTracker: PerformanceStageTracker = {
    run: runStage,
    snapshot: tracker.snapshot,
    reset: tracker.reset,
    getCurrentStage: tracker.getCurrentStage,
  }

  return {
    runStage,
    stageTracker,
    stopProbe,
    getResult: () => {
      stopProbe()
      const stages = [...stageTimes.values()]
      const cpu = firstFrameCpu ? process.cpuUsage(firstFrameCpu) : { user: 0, system: 0 }
      return {
        providerCpuMs: (cpu.user + cpu.system) / 1_000,
        maxTimerLagMs,
        p99TimerLagMs: getPercentile(timerLagSamples, 0.99),
        timerWindowMs: timerStartedAt === null ? 0 : performance.now() - timerStartedAt,
        timerSamples,
        attributedMs,
        attributedCpuMs,
        maxBlockMs,
        maxBlockCpuMs,
        p95BlockCpuMs: getPercentile(blockCpuSamples, 0.95),
        blockCpuSamples: blockCpuSamples.length,
        stages,
      }
    },
  }
}

const getDispatchAttribution = (stages: Array<BenchmarkStage>) => {
  const adapterStages: Array<PerformanceStage> = [
    "provider_frame_json_parse",
    "provider_frame_route",
    "provider_event_redaction",
  ]
  const providerAdapterMs = stages
    .filter(({ name }) => adapterStages.includes(name))
    .reduce((total, stage) => total + stage.dispatchSelfMs, 0)
  const runtimeEventMs = stages.find(({ name }) => name === "runtime_provider_event")?.dispatchMs ?? 0
  const providerDispatchMs = stages.find(({ name }) => name === "provider_frame_dispatch")?.totalMs ?? 0

  return {
    providerAdapterMs,
    runtimeEventMs,
    providerDispatchMs,
    providerDispatchAttribution: providerDispatchMs > 0 ? (providerAdapterMs + runtimeEventMs) / providerDispatchMs : 0,
  }
}

const seedHistory = ({
  database,
  threadId,
  messageCount,
}: {
  database: Database
  threadId: string
  messageCount: number
}): { leafId: string | null; partBytes: number } => {
  const toolOutput = JSON.stringify({
    results: Array.from({ length: 20 }, (_, index) => ({
      title: `Resultado ${index}`,
      snippet: "s".repeat(1_500),
    })),
  })
  const messages = Array.from({ length: messageCount }, (_, index) => {
    const id = `benchmark-history-${index}`
    const parentId = index === 0 ? null : `benchmark-history-${index - 1}`
    const timestamp = index + 1
    const role = index % 2 === 0 ? "user" : "assistant"
    const text =
      role === "user" ? `Solicitação anterior ${"contexto ".repeat(60)}` : `Resumo ${"resultado ".repeat(30)}`
    const parts =
      role === "user"
        ? [{ type: "text", text }]
        : [
            { type: "text", text },
            {
              type: "tool_call",
              callId: `benchmark-history-tool-${index}`,
              tool: "search",
              summary: "Resultados anteriores",
              inputJson: JSON.stringify({ query: `consulta ${index}` }),
              outputJson: toolOutput,
              ok: true,
              resolution: "succeeded",
            },
          ]

    return { id, parentId, role, text, parts, timestamp }
  })
  const insert = database.query(
    "INSERT INTO messages (id, thread_id, parent_id, role, kind, status, run_id, text, parts_json, sender_json, source, created_at, updated_at, client_nonce, delivery_status, delivery_deadline) VALUES (?, ?, ?, ?, 'text', 'complete', NULL, ?, ?, NULL, 'local', ?, ?, NULL, NULL, NULL)",
  )
  const setLeaf = database.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?")

  database.transaction(() => {
    messages.forEach((message) => {
      insert.run(
        message.id,
        threadId,
        message.parentId,
        message.role,
        message.text,
        JSON.stringify(message.parts),
        message.timestamp,
        message.timestamp,
      )
    })
    const leaf = messages.at(-1)
    if (leaf) setLeaf.run(leaf.id, threadId)
  })()

  const partBytes = messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message.parts)), 0)
  return { leafId: messages.at(-1)?.id ?? null, partBytes }
}

const waitForTurnStart = async (requestLogPath: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const requestLog = Bun.file(requestLogPath)
    if ((await requestLog.exists()) && (await requestLog.text()).includes('"method":"turn/start"')) return
    await Bun.sleep(5)
  }
  throw new Error("Synthetic provider did not reach turn/start")
}

const runReplay = async (count: number, historyMessages = 0, switchBranch = false): Promise<BenchmarkResult> => {
  const repoRoot = resolve(import.meta.dir, "../../..")
  const root = mkdtempSync(join(repoRoot, ".touri-provider-event-benchmark-"))
  replayCleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const assets = mkdtempSync(join(root, "fixture-"))
  replayCleanups.push(() => rmSync(assets, { recursive: true, force: true }))
  const fakePath = join(assets, "fake-codex")
  const scenarioPath = join(assets, "scenario.json")
  const requestLogPath = join(assets, "requests.jsonl")
  const pauseBeforeTurnStart = switchBranch ? join(assets, "resume-turn-start") : null
  const fakeCodex = join(import.meta.dir, "../fakes/fake-codex.ts")
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(fakeCodex)} "$@"\n`
  writeFileSync(fakePath, wrapper, { mode: 0o700 })
  chmodSync(fakePath, 0o700)
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      events: getReplayEvents(count),
      ...(pauseBeforeTurnStart ? { pauseBeforeTurnStart, requestLogPath } : {}),
    }),
  )

  const stages = getTrackedRunner()
  const runtime = createKernel({ appData: root, stageTracker: stages.stageTracker })
  replayCleanups.push(() => runtime.stop())
  runtime.kernel.spawnTree = fakeProviderSpawn(runtime.kernel.spawnTree, fakePath, scenarioPath)
  await initStore(runtime.kernel, stages.runStage)
  const database = runtime.kernel.db as Database
  database
    .query(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('benchmark-bot','Benchmark','codex',?,1,1)",
    )
    .run(root)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Conversation store unavailable")
  const createdThread = store.createThread({ botId: "benchmark-bot", kind: "main", title: "Benchmark" })
  if (!createdThread.success) throw new Error(createdThread.error)
  const threadId = createdThread.thread.id
  const history = seedHistory({ database, threadId, messageCount: historyMessages })
  const request = store.insertMessage({
    message: {
      id: "benchmark-request",
      threadId,
      parentId: history.leafId,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Reproduzir uma conversa de teste.",
      parts: [{ type: "text", text: "Reproduzir uma conversa de teste." }],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)

  // Observe the running turn directly; bus delivery may wait for a later slice.
  let streamingReplyId: string | null = null
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    const result = stages.runStage(stage, action, input)
    if (stage === "runtime_provider_event" && queued.success && queued.run.replyMessageId)
      streamingReplyId = queued.run.replyMessageId
    return result
  }
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    codexCommand: fakePath,
    environment: { PATH: process.env.PATH ?? "/usr/bin", TOURI_FAKE_SCENARIO: scenarioPath },
    runStage,
  })
  replayCleanups.push(() => engine.shutdown())
  const events: Array<string> = []
  const unsubscribe = runtime.kernel.subscribe(({ event }) => {
    events.push(event.type)
  })
  replayCleanups.push(unsubscribe)
  replayCleanups.push(stages.stopProbe)

  const queued = engine.enqueue({
    threadId,
    requestMessageId: request.message.id,
    trigger: "user",
  })
  if (!queued.success) throw new Error(queued.error)
  const duplicate = engine.enqueue({
    threadId,
    requestMessageId: request.message.id,
    trigger: "user",
  })
  if (!duplicate.success) throw new Error(duplicate.error)
  const duplicateActiveRuns = (
    database
      .query(
        "SELECT COUNT(*) AS count FROM runs WHERE thread_id = ? AND request_message_id = ? AND status IN ('queued', 'starting', 'running')",
      )
      .get(threadId, request.message.id) as { count: number }
  ).count
  if (pauseBeforeTurnStart && history.leafId) {
    await waitForTurnStart(requestLogPath)
    // The request stays durable while a user switches the visible branch during provider startup.
    database.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(history.leafId, threadId)
    writeFileSync(pauseBeforeTurnStart, "resume")
  }
  const deadline = Date.now() + 30_000
  while (["queued", "starting", "running"].includes(queued.run.status)) {
    if (Date.now() > deadline) throw new Error("Synthetic provider replay timed out")
    await Bun.sleep(5)
  }
  expect(queued.run.status).toBe("succeeded")
  const performanceResult = stages.getResult()
  const dispatch = getDispatchAttribution(performanceResult.stages)
  console.log(
    `provider-event-profile ${JSON.stringify({
      historyMessages,
      historyPartBytes: history.partBytes,
      providerCpuMs: performanceResult.providerCpuMs,
      ...dispatch,
      stages: performanceResult.stages.filter(({ name }) =>
        [
          "provider_frame_batch",
          "provider_frame_dispatch",
          "provider_frame_json_parse",
          "provider_frame_route",
          "provider_event_redaction",
          "runtime_request_path_lookup",
          "runtime_provider_event",
        ].some((stage) => stage === name),
      ),
    })}`,
  )
  store.flushWrites?.()
  await store.flushWritesAsync?.()
  await Bun.sleep(5)
  const reply = store.activePath({ threadId }).find((message) => message.runId === queued.run.id)
  if (!reply) throw new Error("Synthetic provider reply missing")
  expect(reply.parentId).toBe(request.message.id)
  expect(events.length).toBeGreaterThan(0)
  const result: BenchmarkResult = {
    events: count + 2,
    historyMessages,
    historyPartBytes: history.partBytes,
    parts: reply.parts.length,
    replyDigest: createHash("sha256")
      .update(
        JSON.stringify(
          reply.parts.map((part) =>
            Object.fromEntries(Object.entries(part).filter(([key]) => key !== "startedAt" && key !== "resolvedAt")),
          ),
        ),
      )
      .digest("hex"),
    busEvents: events.length,
    busPartsEvents: events.filter((type) => type === "message.parts").length,
    duplicateSharesRun: duplicate.run.id === queued.run.id && duplicate.run === queued.run,
    duplicateActiveRuns,
    retainedRunStates: engine.getRetainedRunStateCount(),
    ...performanceResult,
    ...dispatch,
    streamingReply: streamingReplyId !== null && streamingReplyId === queued.run.replyMessageId,
    providerDispatchCalls: performanceResult.stages.find(({ name }) => name === "provider_frame_dispatch")?.calls ?? 0,
    runtimeEventCalls:
      performanceResult.stages.find(({ name }) => name === "runtime_provider_event")?.dispatchCalls ?? 0,
  }
  console.log(`provider-event-benchmark ${JSON.stringify(result)}`)
  const completedCleanups = replayCleanups
  replayCleanups = []
  await runReplayCleanups(completedCleanups)
  return result
}

const runBestHistoryReplay = async (historyMessages: number): Promise<BenchmarkResult> => {
  // Choose the fastest of three sequential samples to reduce descheduling noise.
  const replays = [
    await runReplay(60, historyMessages),
    await runReplay(60, historyMessages),
    await runReplay(60, historyMessages),
  ]

  replays.forEach((replay) => {
    expect(replay.timerSamples).toBeGreaterThan(0)
    expect(replay.maxTimerLagMs).toBeLessThan(50)
    expect(replay.maxBlockMs).toBeLessThan(50)
    expect(replay.maxBlockCpuMs).toBeLessThan(50)
    expect(replay.runtimeEventMs / replay.runtimeEventCalls).toBeLessThan(1)
    expect(replay.providerDispatchMs / replay.providerDispatchCalls).toBeLessThan(1)
    expect(replay.providerDispatchAttribution).toBeGreaterThanOrEqual(0.9)
    expect(replay.retainedRunStates).toBe(0)
  })

  return replays.reduce((fastest, replay) =>
    replay.providerDispatchMs < fastest.providerDispatchMs ? replay : fastest,
  )
}

const runBestLargeReplyReplay = async (): Promise<BenchmarkResult> => {
  const replays = [await runReplay(6_000), await runReplay(6_000), await runReplay(6_000)]

  replays.forEach((replay) => {
    expect(replay.timerSamples).toBeGreaterThan(0)
    expect(replay.parts).toBe(836)
    // Guard the ordering stage in every sample so aggregate CPU limits cannot hide a regression.
    expect(replay.stages.find(({ name }) => name === "stream_part_preparation")?.maxMs ?? Infinity).toBeLessThan(10)
    expect(replay.replyDigest).toBe("d6725c839f90a1042317c0d969d16bc444e30c20a4bf55b41ef425c1207ee071")
    // Finalization must meet the 50 ms maximum in every replay, including its slowest tick.
    expect(replay.maxTimerLagMs).toBeLessThan(50)
    expect(replay.p99TimerLagMs).toBeLessThan(50)
    expect(replay.maxBlockMs).toBeLessThan(50)
    expect(replay.maxBlockCpuMs).toBeLessThan(50)
    expect(replay.retainedRunStates).toBe(0)
  })

  // Process CPU includes persistence workers; compare scaling with the least noisy CPU sample.
  return replays.reduce((fastest, replay) => (replay.providerCpuMs < fastest.providerCpuMs ? replay : fastest))
}

test("Provider event cost grows linearly and duplicate starts share one run", async () => {
  const small = await runReplay(3_000)
  const result = await runBestLargeReplyReplay()

  expect(result.events).toBe(6_002)
  expect(small.events).toBe(3_002)
  expect(result.parts).toBe(836)
  expect(result.busEvents).toBeGreaterThan(0)
  expect(result.duplicateSharesRun).toBe(true)
  expect(result.duplicateActiveRuns).toBe(1)
  expect(result.providerCpuMs).toBeGreaterThan(0)
  // CI runners measured 573–761 ms for this replay; the ratio below guards linear growth.
  expect(result.providerCpuMs).toBeLessThan(1_500)
  expect(result.providerCpuMs / small.providerCpuMs).toBeLessThan(3)
  // Process CPU includes persistence-worker work that the event-loop stages do not measure.
  expect(result.attributedCpuMs / result.providerCpuMs).toBeGreaterThanOrEqual(0.85)
  expect(result.stages.some(({ name }) => name === "runtime_turn_finalization")).toBe(true)
  // Streaming blocks are budgeted on CPU time (wall time on shared CI runners includes preemption).
  // A single block can spike by a few ms from GC or noisy neighbours, so the tight budget is on the
  // p95 block and a looser guard stays on the max: a per-event O(history) regression moves every block.
  // An empty sample list would pass the p95 check, so require that blocks were recorded.
  expect(result.blockCpuSamples).toBeGreaterThan(20)
  expect(result.p95BlockCpuMs).toBeLessThan(30)
  // Turn finalization runs once per turn and grows with the number of parts (836 here).
  expect(result.stages.find(({ name }) => name === "runtime_turn_finalization")?.maxMs ?? Infinity).toBeLessThan(250)
  expect(result.stages.find(({ name }) => name === "provider_frame_batch")?.maxMs ?? Infinity).toBeLessThan(50)
  expect(result.stages.find(({ name }) => name === "runtime_provider_event")?.maxMs ?? Infinity).toBeLessThan(50)
})

test("Provider event cost stays independent of conversation history", async () => {
  const recent = await runBestHistoryReplay(100)
  const result = await runBestHistoryReplay(1_000)
  const recentPerEventMs = recent.runtimeEventMs / recent.runtimeEventCalls
  const resultPerEventMs = result.runtimeEventMs / result.runtimeEventCalls
  const recentPerFrameMs = recent.providerDispatchMs / recent.providerDispatchCalls
  const resultPerFrameMs = result.providerDispatchMs / result.providerDispatchCalls
  const recentPathLookups = recent.stages.find(({ name }) => name === "runtime_request_path_lookup")?.calls ?? 0
  const resultPathLookups = result.stages.find(({ name }) => name === "runtime_request_path_lookup")?.calls ?? 0

  expect(result.providerDispatchMs).toBeGreaterThan(0)
  expect(result.providerAdapterMs).toBeGreaterThan(0)
  expect(result.providerDispatchAttribution).toBeGreaterThanOrEqual(0.9)
  expect(result.providerDispatchAttribution).toBeLessThanOrEqual(1)
  expect(result.stages.find(({ name }) => name === "provider_frame_json_parse")?.dispatchCalls).toBe(
    result.providerDispatchCalls,
  )
  expect(result.stages.find(({ name }) => name === "provider_frame_route")?.dispatchCalls).toBe(
    result.providerDispatchCalls,
  )
  expect(result.stages.find(({ name }) => name === "provider_event_redaction")?.dispatchCalls ?? 0).toBeGreaterThan(0)
  expect(result.runtimeEventMs).toBeLessThanOrEqual(result.providerDispatchMs)
  expect(result.historyMessages).toBe(1_000)
  expect(result.historyPartBytes).toBeGreaterThan(15_000_000)
  expect(recent.historyMessages).toBe(100)
  expect(recent.historyPartBytes).toBeGreaterThan(1_500_000)
  expect(recentPathLookups).toBe(1)
  expect(resultPathLookups).toBe(1)
  expect(recent.retainedRunStates).toBe(0)
  expect(result.retainedRunStates).toBe(0)
  expect(resultPerEventMs).toBeLessThan(recentPerEventMs * 3 + 0.5)
  expect(resultPerFrameMs).toBeLessThan(recentPerFrameMs * 3 + 0.5)
})

test("A startup branch switch still publishes a streaming reply attached to the validated request", async () => {
  const result = await runReplay(60, 100, true)

  expect(result.streamingReply).toBe(true)
  expect(result.stages.find(({ name }) => name === "runtime_request_path_lookup")?.calls).toBe(1)
})

test("Dispatch attribution exposes time outside the named stages and avoids counting nested spans twice", () => {
  let elapsed = 0
  const stages = getTrackedRunner(() => elapsed)

  stages.runStage("provider_frame_dispatch", () => {
    elapsed += 30
    stages.runStage("provider_frame_json_parse", () => {
      elapsed += 2
    })
    stages.runStage("provider_frame_route", () => {
      elapsed += 2
      stages.runStage("provider_event_redaction", () => {
        elapsed += 2
        stages.runStage("runtime_provider_event", () => {
          elapsed += 4
        })
      })
    })
  })
  const attribution = getDispatchAttribution(stages.getResult().stages)

  expect(attribution.providerAdapterMs).toBe(6)
  expect(attribution.runtimeEventMs).toBe(4)
  expect(attribution.providerDispatchMs).toBe(40)
  expect(attribution.providerDispatchAttribution).toBe(0.25)
  expect(attribution.providerDispatchAttribution).toBeLessThan(0.9)
})
