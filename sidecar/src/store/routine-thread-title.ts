import type { RoutineThreadTitle, Thread } from "@touri/contracts"
import { formatRoutineTitle, validTimezone } from "@touri/contracts/routine-cron"
import type { createStoreReader } from "./reader"

type TitleRow = Omit<RoutineThreadTitle, "sourceTitle"> & { threadId: string; title: string }
type ThreadTitle = Pick<Thread, "id" | "title" | "routineTitle">

/** Call only with IDs from an already-authorized conversation response. */
export const getRoutineThreadTitles = async (
  reader: Pick<ReturnType<typeof createStoreReader>, "getRows">,
  threadIds: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, RoutineThreadTitle>> => {
  const titles = new Map<string, RoutineThreadTitle>()
  // Indexed candidates, read off the live event loop; never traverse the run history.
  for (let offset = 0; offset < threadIds.length; offset += 50) {
    const ids = threadIds.slice(offset, offset + 50)
    const rows = await reader.getRows<TitleRow>(getRoutineThreadTitleQuery(ids), signal)
    rows.filter(isAutomaticTitle).forEach(({ threadId, title, name, scheduledFor, timezone }) => {
      titles.set(threadId, { sourceTitle: title, name, scheduledFor, timezone })
    })
  }

  return titles
}

export const getThreadsWithRoutineTitles = <T extends ThreadTitle>(
  threads: readonly T[],
  titles: ReadonlyMap<string, RoutineThreadTitle>,
): T[] => threads.map((thread) => ({ ...thread, routineTitle: titles.get(thread.id) }))

/** Ordinary conversations must not start a metadata reader during workspace loading. */
export const getRoutineThreadCandidateIds = (threads: readonly Pick<Thread, "id" | "title">[]): string[] =>
  threads
    .filter((thread) => / · \d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2}\s[AP]M$/u.test(thread.title))
    .map((thread) => thread.id)

export const getRoutineThreadTitleQuery = (threadIds: readonly string[]) => ({
  sql: `SELECT t.id AS threadId, t.title, r.name, rr.scheduled_for AS scheduledFor, r.timezone
    FROM threads t
    JOIN routine_runs rr ON rr.id = coalesce(t.routine_run_id,
      (SELECT id FROM routine_runs WHERE thread_id = t.id ORDER BY rowid LIMIT 1))
    JOIN routines r ON r.id = rr.routine_id
    WHERE t.id IN (${threadIds.map(() => "?").join(",")}) AND rr.thread_id = t.id
      AND ((t.group_id IS NOT NULL AND t.group_id = r.group_id)
        OR (t.group_id IS NULL AND r.group_id IS NULL AND t.bot_id = r.bot_id))`,
  bindings: [...threadIds],
})

const isAutomaticTitle = ({ title, name, scheduledFor, timezone }: TitleRow): boolean =>
  Number.isFinite(scheduledFor) &&
  validTimezone(timezone) &&
  title === formatRoutineTitle({ name, at: scheduledFor, timezone })
