import type { RoutineRun, Thread } from "@touri/contracts"

export type SidebarThread = {
  thread: Thread
  routineRun: RoutineRun | undefined
  running: boolean
  unread: number
  deletedRoutine: boolean
}

export const getSidebarThreads = (
  threads: readonly Thread[],
  routineRuns: readonly RoutineRun[],
  selectedThreadId: string | null,
  runningThreadIds: ReadonlySet<string> = new Set(),
  routineIds?: ReadonlySet<string>,
): SidebarThread[] => {
  const getRoutineRun = getRoutineRunLookup(routineRuns)
  const visibleThreads = threads.filter((thread) => !thread.groupId && thread.archivedAt === null)
  const entries = visibleThreads.map((thread): SidebarThread => {
    const routineRun = getRoutineRun(thread)
    const deletedRoutine =
      thread.kind === "routine" && (!routineRun || (routineIds !== undefined && !routineIds.has(routineRun.routineId)))

    return { thread, routineRun, deletedRoutine, running: runningThreadIds.has(thread.id), unread: thread.unread }
  })
  // This local index keeps grouping linear as frequent routines accumulate history.
  const groups = entries.reduce((byRoutine, entry) => {
    const key = getSidebarGroupKey(entry.thread, entry.routineRun, routineIds)
    const previous = byRoutine.get(key)
    if (!previous) return byRoutine.set(key, entry)

    const representative = getRepresentativeThread(previous, entry, selectedThreadId)

    return byRoutine.set(key, {
      ...representative,
      running: previous.running || entry.running,
      unread: previous.unread + entry.unread,
    })
  }, new Map<string, SidebarThread>())

  return [...groups.values()].toSorted((left, right) => {
    const kindOrder = Number(left.thread.kind === "routine") - Number(right.thread.kind === "routine")
    if (kindOrder) return kindOrder

    return (
      (right.routineRun?.scheduledFor ?? right.thread.updatedAt) -
      (left.routineRun?.scheduledFor ?? left.thread.updatedAt)
    )
  })
}

export const getSidebarReadThreadIds = (
  threads: readonly Thread[],
  routineRuns: readonly RoutineRun[],
  threadId: string,
  routineIds: ReadonlySet<string>,
): ReadonlySet<string> => {
  const selected = threads.find((thread) => thread.id === threadId)
  if (!selected || selected.kind !== "routine" || selected.groupId) return new Set([threadId])

  const getRoutineRun = getRoutineRunLookup(routineRuns)
  const key = getSidebarGroupKey(selected, getRoutineRun(selected), routineIds)
  const group = threads.filter(
    (thread) =>
      !thread.groupId &&
      thread.archivedAt === null &&
      getSidebarGroupKey(thread, getRoutineRun(thread), routineIds) === key,
  )

  return new Set(group.map((thread) => thread.id))
}

export const getSidebarDataByBot = (threads: readonly Thread[], routineRuns: readonly RoutineRun[]) => {
  const threadBots = new Map(threads.map((thread) => [thread.id, thread.botId]))
  const runBots = new Map(threads.map((thread) => [thread.routineRunId, thread.botId]))
  // Local indexes avoid copying accumulated history or scanning the workspace for each bot.
  const byBot = threads.reduce((index, thread) => {
    const entry = index.get(thread.botId) ?? { threads: [], routineRuns: [] }
    entry.threads.push(thread)
    index.set(thread.botId, entry)

    return index
  }, new Map<string, { threads: Thread[]; routineRuns: RoutineRun[] }>())
  routineRuns.forEach((run) => {
    const botId = threadBots.get(run.threadId ?? "") ?? runBots.get(run.id)
    if (!botId) return

    byBot.get(botId)?.routineRuns.push(run)
  })

  return byBot
}

const getSidebarGroupKey = (thread: Thread, routineRun: RoutineRun | undefined, routineIds?: ReadonlySet<string>) => {
  if (thread.kind !== "routine") return `thread:${thread.id}`
  if (!routineRun || (routineIds !== undefined && !routineIds.has(routineRun.routineId)))
    return `deleted:${thread.botId}`

  return `routine:${routineRun.routineId}`
}

const getRoutineRunLookup = (routineRuns: readonly RoutineRun[]) => {
  const runsById = new Map(routineRuns.map((run) => [run.id, run]))
  // Keep the newest run per thread in one pass, without sorting the run history.
  const latestRunsByThread = routineRuns.reduce((index, run) => {
    const previous = index.get(run.threadId)
    if (!previous || run.scheduledFor > previous.scheduledFor) index.set(run.threadId, run)

    return index
  }, new Map<string | null, RoutineRun>())

  return (thread: Thread) => {
    if (thread.kind !== "routine") return undefined

    return latestRunsByThread.get(thread.id) ?? runsById.get(thread.routineRunId ?? "")
  }
}

const getRepresentativeThread = (
  previous: SidebarThread,
  next: SidebarThread,
  selectedThreadId: string | null,
): SidebarThread => {
  if (next.thread.id === selectedThreadId) return next
  if (previous.thread.id === selectedThreadId) return previous
  if (
    (next.routineRun?.scheduledFor ?? next.thread.createdAt) >
    (previous.routineRun?.scheduledFor ?? previous.thread.createdAt)
  )
    return next

  return previous
}
