import type { Run } from "@touri/contracts"

export const getPrecedingWorkRun = (run: Run, ongoing: ReadonlyMap<string, Run>): Run | undefined => {
  if (run.status !== "queued") return undefined

  const preceding = ongoing.get(getWorkConversationKey(run))
  if (!preceding || preceding.queuedAt > run.queuedAt) return undefined

  return preceding
}

export const getOngoingWorkRuns = (runs: readonly Run[]): ReadonlyMap<string, Run> =>
  new Map(
    runs
      .filter(
        (candidate) =>
          candidate.kind !== "coordination" && (candidate.status === "starting" || candidate.status === "running"),
      )
      .map((candidate) => [getWorkConversationKey(candidate), candidate]),
  )

const getWorkConversationKey = (run: Run): string => JSON.stringify([run.botId, run.groupThreadId ?? run.threadId])
