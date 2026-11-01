import type { Run } from "@touri/contracts"
import { type Locale, t } from "../../i18n"

export const getQueueLabel = (run: Run, locale: Locale = "pt-BR", scope: "runtime" | "bot" = "runtime"): string => {
  if (scope === "bot" && run.queuePosition && run.queueTotal)
    return t("Work bot queue position", { position: run.queuePosition, total: run.queueTotal }, locale)
  if (run.kind === "coordination") return t("Work waiting for bot", {}, locale)
  if (!run.queuePosition || !run.queueTotal) return t("Work waiting for slot", {}, locale)

  return t("Work queue position", { position: run.queuePosition, total: run.queueTotal }, locale)
}

export const getWorkStateLabel = (run: Run, scope: "runtime" | "bot" = "runtime"): string => {
  if (run.status === "queued") return getQueueLabel(run, "pt-BR", scope)
  if (run.status === "starting") return t("Work preparing")

  return t("Em execução")
}

export const getQueuedWorkRuns = (runs: readonly Run[]): Run[] => {
  // Sort only the fresh projection; older supported browsers need Array.sort.
  const queued = runs
    .flatMap((run) => {
      if (run.kind !== "coordination") return run.status === "queued" ? [run] : []
      if (!["queued", "starting", "running"].includes(run.status)) return []
      if (!run.pendingBotIds) return run.status === "queued" ? [run] : []

      return run.pendingBotIds.map((botId) => ({ ...run, botId, status: "queued" as const }))
    })
    .sort((first, second) => first.queuedAt - second.queuedAt)

  // Fresh counters keep per-bot numbering linear without mutating the workspace snapshot.
  const totals = new Map<string, number>()
  const positions = new Map<string, number>()
  queued
    .filter((run) => run.kind === "coordination")
    .forEach((run) => {
      totals.set(run.botId, (totals.get(run.botId) ?? 0) + 1)
    })

  return queued.map((run) => {
    if (run.kind !== "coordination" || !run.pendingBotIds) return run

    const position = (positions.get(run.botId) ?? 0) + 1
    positions.set(run.botId, position)
    return { ...run, queuePosition: position, queueTotal: totals.get(run.botId) ?? 1 }
  })
}
