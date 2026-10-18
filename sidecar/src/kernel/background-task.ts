import type { PerformanceStage, PerformanceStageRunner } from "./performance"

// Interval callbacks own one in-flight pass. A slow host must not accumulate
// overlapping scans; disposal prevents new work and lets bounded steps stop.
export const createBackgroundTask = (
  stage: PerformanceStage,
  action: () => Promise<void>,
  runStage?: PerformanceStageRunner,
) => {
  let running = false
  let stopped = false
  const run = async (): Promise<void> => {
    if (running || stopped) return

    running = true
    try {
      if (runStage) await runStage(stage, action)
      else await action()
    } finally {
      running = false
    }
  }

  return {
    run,
    dispose: () => {
      stopped = true
    },
    isStopped: () => stopped,
  }
}

export const getMeasuredStage =
  (stage: PerformanceStage, runStage?: PerformanceStageRunner) =>
  <Value>(action: () => Value): Value =>
    runStage ? runStage(stage, action) : action()

export const yieldBackground = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
