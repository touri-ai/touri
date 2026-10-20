import type { Message, Routine, RoutineRun, Run, Thread } from "@touri/contracts"

export const isRoutineConversation = ({
  thread,
  runs,
  routineRuns,
  routines,
}: {
  thread: Thread
  runs: readonly Run[]
  routineRuns: readonly RoutineRun[]
  routines: readonly Routine[]
}): boolean => {
  if (thread.kind === "main") return false
  if (thread.kind === "routine") return true
  if (thread.routineRunId !== null && thread.routineRunId !== undefined) return true
  if (runs.some((run) => run.threadId === thread.id && isRoutineRun(run))) return true
  if (routineRuns.some((run) => run.threadId === thread.id && run.runId !== null)) return true

  return routines.some((routine) => routine.resultsThreadId === thread.id)
}

export const getRoutineReplyRun = (
  message: Message,
  runs: readonly Run[],
  messages: readonly Message[],
): Run | undefined => {
  const run = runs.find((candidate) => candidate.id === message.runId)
  if (run?.status !== "succeeded") return undefined
  if (isRoutineRun(run)) return run

  const routineRuns = runs.filter((candidate) => candidate.threadId === message.threadId && isRoutineRun(candidate))
  if (!routineRuns.length) return undefined

  const request = getNearestUserRequest(message, messages)
  if (!request) return undefined

  return routineRuns.find((candidate) => candidate.requestMessageId === request.id)
}

export const isRoutineRun = (run: Run): boolean => run.trigger === "routine" || run.routineRunId != null

/** Only no-news responses are presentation tokens; unknown NO_* values may describe errors. */
export const isRoutineEmptyResult = (text: string): boolean =>
  /^NO_(?:NOTIFICATIONS?|REPLY|UPDATES?|NEWS|ALERTS?|CHANGES?)$/.test(text.trim())

const getNearestUserRequest = (message: Message, messages: readonly Message[]): Message | undefined => {
  const byId = new Map(
    messages
      .filter((candidate) => candidate.threadId === message.threadId)
      .map((candidate) => [candidate.id, candidate]),
  )
  let parentId = message.parentId
  let remainingAncestors = byId.size

  // The history size bounds this local walk even when older snapshots contain a cycle.
  while (parentId && remainingAncestors > 0) {
    const parent = byId.get(parentId)
    if (!parent) return undefined
    if (parent.role === "user") return parent

    parentId = parent.parentId
    remainingAncestors -= 1
  }

  return undefined
}
