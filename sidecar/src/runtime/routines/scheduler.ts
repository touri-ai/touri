import type { HostNotification, Kernel } from "@touri/contracts"
import type { PerformanceStageRunner } from "../../kernel/performance"
import type { createRuntimeEngine } from "../engine"

type Engine = ReturnType<typeof createRuntimeEngine>

export const createRoutineScheduler = ({
  kernel,
  engine,
  intervalMs = 30_000,
  runStage,
}: {
  kernel: Kernel
  engine: Engine
  intervalMs?: number
  runStage?: PerformanceStageRunner
}): { stop: () => void; tick: (now?: number) => Promise<void> } => {
  const tick = (now?: number): Promise<void> =>
    runStage ? runStage("routine_scheduler_dispatch", () => engine.tick(now)) : engine.tick(now)
  const timer = setInterval(() => void tick(), intervalMs)
  const timerWithUnref = timer as unknown as { unref?: () => void }
  timerWithUnref.unref?.()
  const onHostNotification = (notification: HostNotification): void => {
    if (notification.method === "power.sleep" && notification.params.sleeping === false) void tick()
  }
  const unsubscribe = kernel.onHostNotification(onHostNotification)
  void tick()
  return {
    stop: () => {
      clearInterval(timer)
      unsubscribe()
    },
    tick,
  }
}
