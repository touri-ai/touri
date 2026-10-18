import { expect, test } from "bun:test"
import type { Kernel } from "@touri/contracts"
import { createPerformanceDiagnostics, createPerformanceStageTracker } from "../../src/kernel/performance"

test("a completed stage and its cleared marker survive until the delayed lag sampler", () => {
  let at = 0
  let sample = () => {}
  let warnings: Array<Parameters<Kernel["log"]>[0]> = []
  const diagnostics = createPerformanceDiagnostics({
    log: (entry) => {
      warnings = warnings.concat(entry)
    },
    getContext: () => ({ activeRuns: 1, sseClients: 0, websocketClients: 2 }),
    now: () => at,
    startSampling: (callback) => {
      sample = callback

      return () => {}
    },
  })

  diagnostics.runStage("stream_batch", () => {
    diagnostics.runStage("workspace_snapshot", () => {
      at = 12_000
    })
  })
  diagnostics.runStage("routine_scheduler_dispatch", () => 0)
  sample()
  sample()
  diagnostics.stop()

  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.data?.stages).toEqual([
    { stage: "stream_batch", calls: 1, totalMs: 12_000, maxMs: 12_000 },
    { stage: "workspace_snapshot", calls: 1, totalMs: 12_000, maxMs: 12_000 },
    { stage: "routine_scheduler_dispatch", calls: 1, totalMs: 0, maxMs: 0 },
  ])
  expect(warnings[0]?.data?.inFlight).toEqual([])
})

test("untrusted stage names cannot displace internal counters or enter warning snapshots", () => {
  const tracker = createPerformanceStageTracker(() => 0)
  const names = Array.from({ length: 100 }, (_, index) => `untrusted-${index}`)

  // Reflect exercises the runtime boundary without weakening the fixed-name TypeScript API.
  names.forEach((name) => {
    Reflect.apply(tracker.run, undefined, [name, () => 1])
  })
  tracker.run("history_backfill_batch", () => 2)
  const snapshot = tracker.snapshot()

  expect(snapshot).toEqual([{ stage: "history_backfill_batch", calls: 1, totalMs: 0, maxMs: 0 }])
  expect(JSON.stringify(snapshot)).not.toContain("untrusted")
})
