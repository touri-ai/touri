import type { Run } from "@touri/contracts"
import { type Locale, t } from "../../i18n"

export const getQueueLabel = (run: Run, locale: Locale = "pt-BR"): string => {
  if (run.kind === "coordination") return t("Work waiting for bot", {}, locale)
  if (!run.queuePosition || !run.queueTotal) return t("Work waiting for slot", {}, locale)

  return t("Work queue position", { position: run.queuePosition, total: run.queueTotal }, locale)
}

export const getWorkStateLabel = (run: Run): string => {
  if (run.status === "queued") return getQueueLabel(run)
  if (run.status === "starting") return t("Work preparing")

  return t("Em execução")
}

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
