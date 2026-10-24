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
