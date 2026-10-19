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
  parts: number
  providerCpuMs: number
  attributedMs: number
  attributedCpuMs: number
  maxBlockMs: number
  duplicateSharesRun: boolean
  duplicateActiveRuns: number
  busEvents: number
  busPartsEvents: number
  stages: Array<{ name: string; calls: number; totalMs: number; maxMs: number }>
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
  let firstFrameCpu: NodeJS.CpuUsage | null = null
  const stageTimes = new Map<PerformanceStage, { calls: number; totalMs: number; maxMs: number }>()
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    if (stage === "provider_frame_batch" && firstFrameCpu === null) firstFrameCpu = process.cpuUsage()
    const parentDepth = depth
    const cpuStartedAt = parentDepth === 0 && firstFrameCpu !== null ? process.cpuUsage() : null
    depth += 1
    const startedAt = performance.now()
    try {
      return tracker.run(stage, action, input)
    } finally {
      const elapsed = performance.now() - startedAt
      depth -= 1
      const previous = stageTimes.get(stage) ?? { calls: 0, totalMs: 0, maxMs: 0 }
      stageTimes.set(stage, {
        calls: previous.calls + 1,
        totalMs: previous.totalMs + elapsed,
        maxMs: Math.max(previous.maxMs, elapsed),
      })
      if (parentDepth === 0 && firstFrameCpu !== null) {
        attributedMs += elapsed
        maxBlockMs = Math.max(maxBlockMs, elapsed)
        if (cpuStartedAt) {
          const cpu = process.cpuUsage(cpuStartedAt)
          attributedCpuMs += (cpu.user + cpu.system) / 1_000
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
        stages,
      }
    },
  }
}

const runReplay = async (count: number): Promise<BenchmarkResult> => {
  const root = mkdtempSync(join(tmpdir(), "touri-provider-event-benchmark-"))
  replayCleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const assets = mkdtempSync(join(tmpdir(), "touri-provider-event-fixture-"))
  replayCleanups.push(() => rmSync(assets, { recursive: true, force: true }))
  const fakePath = join(assets, "fake-codex")
  const scenarioPath = join(assets, "scenario.json")
  const fakeCodex = join(import.meta.dir, "../fakes/fake-codex.ts")
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(fakeCodex)} "$@"\n`
  writeFileSync(fakePath, wrapper, { mode: 0o700 })
  chmodSync(fakePath, 0o700)
  writeFileSync(scenarioPath, JSON.stringify({ events: getReplayEvents(count) }))

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
  const request = store.insertMessage({
    message: {
      id: "benchmark-request",
      threadId,
      parentId: null,
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
  const deadline = Date.now() + 30_000
  while (["queued", "starting", "running"].includes(queued.run.status)) {
    if (Date.now() > deadline) throw new Error("Synthetic provider replay timed out")
    await Bun.sleep(5)
  }
  expect(queued.run.status).toBe("succeeded")
  const performanceResult = stages.getResult()
  store.flushWrites?.()
  await Bun.sleep(5)
  const reply = store.activePath({ threadId }).find((message) => message.role === "assistant")
  if (!reply) throw new Error("Synthetic provider reply missing")
  expect(events.length).toBeGreaterThan(0)
  const result: BenchmarkResult = {
    events: count + 2,
    parts: reply.parts.length,
    busEvents: events.length,
    busPartsEvents: events.filter((type) => type === "message.parts").length,
    duplicateSharesRun: duplicate.run.id === queued.run.id && duplicate.run === queued.run,
    duplicateActiveRuns,
    ...performanceResult,
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
  expect(result.providerCpuMs).toBeLessThan(1_000)
  expect(result.providerCpuMs / small.providerCpuMs).toBeLessThan(3)
  expect(result.attributedCpuMs / result.providerCpuMs).toBeGreaterThanOrEqual(0.9)
  expect(result.stages.some(({ name }) => name === "runtime_turn_finalization")).toBe(true)
  expect(result.maxBlockMs).toBeLessThan(50)
  expect(result.stages.find(({ name }) => name === "provider_frame_batch")?.maxMs ?? Infinity).toBeLessThan(50)
  expect(result.stages.find(({ name }) => name === "runtime_provider_event")?.maxMs ?? Infinity).toBeLessThan(50)
})
