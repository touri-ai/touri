import type { Database } from "bun:sqlite"
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

type BenchmarkResult = {
  events: number
  historyMessages: number
  historyPartBytes: number
  parts: number
  providerCpuMs: number
  providerDispatchCpuMs: number
  providerAdapterCpuMs: number
  runtimeEventCpuMs: number
  providerDispatchCalls: number
  runtimeEventCalls: number
  attributedMs: number
  attributedCpuMs: number
  maxBlockMs: number
  maxBlockCpuMs: number
  duplicateSharesRun: boolean
  duplicateActiveRuns: number
  busEvents: number
  busPartsEvents: number
  stages: Array<{
    name: string
    calls: number
    totalMs: number
    maxMs: number
    totalCpuMs: number
    maxCpuMs: number
  }>
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

const getTrackedRunner = () => {
  const tracker = createPerformanceStageTracker()
  let depth = 0
  let attributedMs = 0
  let attributedCpuMs = 0
  let maxBlockMs = 0
  let maxBlockCpuMs = 0
  let firstFrameCpu: NodeJS.CpuUsage | null = null
  const stageTimes = new Map<
    PerformanceStage,
    { calls: number; totalMs: number; maxMs: number; totalCpuMs: number; maxCpuMs: number }
  >()
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    if (stage === "provider_frame_batch" && firstFrameCpu === null) firstFrameCpu = process.cpuUsage()
    const parentDepth = depth
    const cpuStartedAt = parentDepth === 0 && firstFrameCpu !== null ? process.cpuUsage() : null
    const stageCpuStartedAt =
      stage === "provider_frame_batch" ||
      stage === "provider_frame_dispatch" ||
      stage === "runtime_request_path_lookup" ||
      stage === "runtime_provider_event"
        ? process.cpuUsage()
        : null
    depth += 1
    const startedAt = performance.now()
    try {
      return tracker.run(stage, action, input)
    } finally {
      const elapsed = performance.now() - startedAt
      const cpu = stageCpuStartedAt ? process.cpuUsage(stageCpuStartedAt) : null
      const elapsedCpuMs = cpu ? (cpu.user + cpu.system) / 1_000 : 0
      depth -= 1
      const previous = stageTimes.get(stage) ?? { calls: 0, totalMs: 0, maxMs: 0, totalCpuMs: 0, maxCpuMs: 0 }
      stageTimes.set(stage, {
        calls: previous.calls + 1,
        totalMs: previous.totalMs + elapsed,
        maxMs: Math.max(previous.maxMs, elapsed),
        totalCpuMs: previous.totalCpuMs + elapsedCpuMs,
        maxCpuMs: Math.max(previous.maxCpuMs, elapsedCpuMs),
      })
      if (parentDepth === 0 && firstFrameCpu !== null) {
        // One-time end-of-turn work is budgeted separately; the block budget covers streaming.
        const streaming = stage !== "runtime_turn_finalization"
        attributedMs += elapsed
        if (streaming) maxBlockMs = Math.max(maxBlockMs, elapsed)
        if (cpuStartedAt) {
          const cpu = process.cpuUsage(cpuStartedAt)
          const blockCpuMs = (cpu.user + cpu.system) / 1_000
          attributedCpuMs += blockCpuMs
          if (streaming) maxBlockCpuMs = Math.max(maxBlockCpuMs, blockCpuMs)
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
    getResult: () => {
      const stages = [...stageTimes].map(([name, timing]) => ({ name, ...timing }))
      const cpu = firstFrameCpu ? process.cpuUsage(firstFrameCpu) : { user: 0, system: 0 }
      return {
        providerCpuMs: (cpu.user + cpu.system) / 1_000,
        attributedMs,
        attributedCpuMs,
        maxBlockMs,
        maxBlockCpuMs,
        stages,
      }
    },
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

const runReplay = async (count: number, historyMessages = 0): Promise<BenchmarkResult> => {
  const root = mkdtempSync(join(tmpdir(), "touri-provider-event-benchmark-"))
  replayCleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const assets = mkdtempSync(join(tmpdir(), "touri-provider-event-fixture-"))
  replayCleanups.push(() => rmSync(assets, { recursive: true, force: true }))
  const fakePath = join(assets, "fake-codex")
  const scenarioPath = join(assets, "scenario.json")
  const requestLogPath = join(assets, "requests.jsonl")
  const pauseBeforeTurnStart = historyMessages ? join(assets, "resume-turn-start") : null
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
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    codexCommand: fakePath,
    environment: { PATH: process.env.PATH ?? "/usr/bin", TOURI_FAKE_SCENARIO: scenarioPath },
    runStage: stages.runStage,
  })
  replayCleanups.push(() => engine.shutdown())
  const events: Array<string> = []
  const unsubscribe = runtime.kernel.subscribe(({ event }) => {
    events.push(event.type)
  })
  replayCleanups.push(unsubscribe)

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
  const providerDispatch = performanceResult.stages.find(({ name }) => name === "provider_frame_dispatch")
  const runtimeEvent = performanceResult.stages.find(({ name }) => name === "runtime_provider_event")
  const providerDispatchCpuMs = providerDispatch?.totalCpuMs ?? 0
  const runtimeEventCpuMs = runtimeEvent?.totalCpuMs ?? 0
  const providerAdapterCpuMs = Math.max(0, providerDispatchCpuMs - runtimeEventCpuMs)
  console.log(
    `provider-event-profile ${JSON.stringify({
      historyMessages,
      historyPartBytes: history.partBytes,
      providerCpuMs: performanceResult.providerCpuMs,
      providerAdapterCpuMs,
      stages: performanceResult.stages.filter(({ name }) =>
        [
          "provider_frame_batch",
          "provider_frame_dispatch",
          "runtime_request_path_lookup",
          "runtime_provider_event",
        ].some((stage) => stage === name),
      ),
    })}`,
  )
  store.flushWrites?.()
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
    busEvents: events.length,
    busPartsEvents: events.filter((type) => type === "message.parts").length,
    duplicateSharesRun: duplicate.run.id === queued.run.id && duplicate.run === queued.run,
    duplicateActiveRuns,
    ...performanceResult,
    providerDispatchCpuMs,
    providerAdapterCpuMs,
    runtimeEventCpuMs,
    providerDispatchCalls: performanceResult.stages.find(({ name }) => name === "provider_frame_dispatch")?.calls ?? 0,
    runtimeEventCalls: performanceResult.stages.find(({ name }) => name === "runtime_provider_event")?.calls ?? 0,
  }
  console.log(`provider-event-benchmark ${JSON.stringify(result)}`)
  return result
}

test("Provider event cost grows linearly and duplicate starts share one run", async () => {
  const small = await runReplay(3_000)
  const result = await runReplay(6_000)

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
  // The 50 ms budget applies to CPU time of streaming blocks: wall time on shared CI runners
  // includes preemption. Wall time keeps a looser guard.
  expect(result.maxBlockCpuMs).toBeLessThan(50)
  expect(result.maxBlockMs).toBeLessThan(150)
  // Turn finalization runs once per turn and grows with the number of parts (836 here).
  expect(result.stages.find(({ name }) => name === "runtime_turn_finalization")?.maxMs ?? Infinity).toBeLessThan(250)
  expect(result.stages.find(({ name }) => name === "provider_frame_batch")?.maxMs ?? Infinity).toBeLessThan(50)
  expect(result.stages.find(({ name }) => name === "runtime_provider_event")?.maxMs ?? Infinity).toBeLessThan(50)
})

test("Provider event cost stays independent of conversation history", async () => {
  const recent = await runReplay(60, 100)
  const result = await runReplay(60, 1_000)
  const recentPerEventCpuMs = recent.runtimeEventCpuMs / recent.runtimeEventCalls
  const resultPerEventCpuMs = result.runtimeEventCpuMs / result.runtimeEventCalls
  const recentPerFrameCpuMs = recent.providerDispatchCpuMs / recent.providerDispatchCalls
  const resultPerFrameCpuMs = result.providerDispatchCpuMs / result.providerDispatchCalls
  const maxFrameCpuMs = result.stages.find(({ name }) => name === "provider_frame_dispatch")?.maxCpuMs ?? Infinity
  const recentPathLookups = recent.stages.find(({ name }) => name === "runtime_request_path_lookup")?.calls ?? 0
  const resultPathLookups = result.stages.find(({ name }) => name === "runtime_request_path_lookup")?.calls ?? 0

  expect(result.providerDispatchCpuMs).toBeGreaterThan(0)
  expect(result.providerAdapterCpuMs).toBeGreaterThan(0)
  expect(result.runtimeEventCpuMs).toBeLessThanOrEqual(result.providerDispatchCpuMs)
  expect(result.historyMessages).toBe(1_000)
  expect(result.historyPartBytes).toBeGreaterThan(15_000_000)
  expect(recent.historyMessages).toBe(100)
  expect(recent.historyPartBytes).toBeGreaterThan(1_500_000)
  expect(recentPathLookups).toBe(1)
  expect(resultPathLookups).toBe(1)
  expect(resultPerEventCpuMs).toBeLessThan(5)
  expect(resultPerFrameCpuMs).toBeLessThan(10)
  expect(resultPerEventCpuMs).toBeLessThan(recentPerEventCpuMs * 3 + 0.5)
  expect(resultPerFrameCpuMs).toBeLessThan(recentPerFrameCpuMs * 3 + 0.5)
  expect(result.maxBlockCpuMs).toBeLessThan(50)
  expect(maxFrameCpuMs).toBeLessThan(50)
})
