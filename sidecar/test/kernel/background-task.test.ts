import { expect, test } from "bun:test"
import { createBackgroundTask, yieldBackground } from "../../src/kernel/background-task"
import { createPerformanceStageTracker } from "../../src/kernel/performance"

test("slow periodic passes never overlap and disposal prevents a fresh pass", async () => {
  const tracker = createPerformanceStageTracker()
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const task = createBackgroundTask(
    "vm_orphan_sweep",
    async () => {
      calls += 1
      await pending
    },
    tracker.run,
  )

  const first = task.run()
  await task.run()
  release()
  await first
  task.dispose()
  await task.run()

  expect(calls).toBe(1)
  expect(tracker.snapshot().map((timing) => timing.stage)).toContain("vm_orphan_sweep")
})

test("async periodic work stays attributed across sampler resets and after an awaited continuation", async () => {
  let now = 0
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const tracker = createPerformanceStageTracker(() => now)

  const pass = tracker.run("browser_session_save", async () => {
    await pending
    now = 6200
  })
  tracker.reset()
  now = 1000
  const active = tracker.snapshot()
  release()
  await pass
  await yieldBackground()

  expect(active).toEqual([
    { stage: "browser_session_save", calls: 0, totalMs: 0, maxMs: 0, pending: 1, pendingMs: 1000 },
  ])
  expect(tracker.snapshot()).toEqual([
    { stage: "browser_session_save", calls: 0, totalMs: 0, maxMs: 0, asyncCalls: 1, asyncMaxMs: 6200 },
  ])
})
