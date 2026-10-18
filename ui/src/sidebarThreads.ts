import type { RoutineRun, Thread } from "@touri/contracts"

export type SidebarThread = {
  thread: Thread
  routineRun: RoutineRun | undefined
  running: boolean
  unread: number
}

export const getSidebarThreads = (
  threads: readonly Thread[],
  routineRuns: readonly RoutineRun[],
  selectedThreadId: string | null,
  runningThreadIds: ReadonlySet<string> = new Set(),
): SidebarThread[] => {
  const runsById = new Map(routineRuns.map((run) => [run.id, run]))
  const latestRunsByThread = new Map(
    [...routineRuns].sort((left, right) => left.scheduledFor - right.scheduledFor).map((run) => [run.threadId, run]),
  )
  const visibleThreads = threads.filter((thread) => !thread.groupId && thread.archivedAt === null)
  const entries = visibleThreads.map((thread): SidebarThread => {
    const routineRun =
      thread.kind === "routine"
        ? (latestRunsByThread.get(thread.id) ?? runsById.get(thread.routineRunId ?? ""))
        : undefined

    return { thread, routineRun, running: runningThreadIds.has(thread.id), unread: thread.unread }
  })
  // This local index keeps grouping linear as frequent routines accumulate history.
  const groups = entries.reduce((byRoutine, entry) => {
    const key = entry.routineRun ? `routine:${entry.routineRun.routineId}` : `thread:${entry.thread.id}`
    const previous = byRoutine.get(key)
    if (!previous) return byRoutine.set(key, entry)

    const representative = getRepresentativeThread(previous, entry, selectedThreadId)

    return byRoutine.set(key, {
      ...representative,
      running: previous.running || entry.running,
      unread: previous.unread + entry.unread,
    })
  }, new Map<string, SidebarThread>())

  return [...groups.values()].sort((left, right) => {
    const kindOrder = Number(left.thread.kind === "routine") - Number(right.thread.kind === "routine")
    if (kindOrder) return kindOrder

    return (
      (right.routineRun?.scheduledFor ?? right.thread.updatedAt) -
      (left.routineRun?.scheduledFor ?? left.thread.updatedAt)
    )
  })
}

const getRepresentativeThread = (
  previous: SidebarThread,
  next: SidebarThread,
  selectedThreadId: string | null,
): SidebarThread => {
  if (next.thread.id === selectedThreadId) return next
  if (previous.thread.id === selectedThreadId) return previous
  if ((next.routineRun?.scheduledFor ?? 0) > (previous.routineRun?.scheduledFor ?? 0)) return next

  return previous
}
