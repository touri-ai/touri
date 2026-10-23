import type { Run } from "@touri/contracts"
import { activeRun } from "../workspaceRetention"

/** Coordination is a placeholder until an execution attaches, never a second provider task. */
export const getGroupProgress = (threadId: string | undefined, runs: Run[]) => {
  const threadRuns = runs.filter((run) => run.threadId === threadId)
  const attachedTurns = new Set(threadRuns.map((run) => run.groupTurnId))
  const active = threadRuns.filter(activeRun)
  const executions = active.filter((run) => run.kind !== "coordination")
  const progress = active.filter((run) => run.kind !== "coordination" || !attachedTurns.has(run.id))
  const control = active.find((run) => run.kind === "coordination") ?? active[0] ?? null

  return { progress, executions, control }
}
