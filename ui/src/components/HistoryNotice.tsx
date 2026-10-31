import { useState } from "react"
import type { HistoryFailure } from "../historyFailure"
import { t } from "../i18n"
import { Notice } from "./Notice"

/** A failed conversation read, shown above the messages that were already loaded. */
export const HistoryNotice = ({ failure, onRetry }: { failure: HistoryFailure; onRetry: () => Promise<void> }) => {
  const [busy, setBusy] = useState(false)
  const copy = getHistoryNoticeCopy(failure)
  const retry = async (): Promise<void> => {
    setBusy(true)
    await onRetry().finally(() => setBusy(false))
  }

  return (
    <Notice
      className="conversation-notice"
      tone={failure.kind === "server" ? "danger" : "warning"}
      title={copy.title}
      cause={copy.cause}
      code={failure.code}
      details={failure.diagnostic}
      action={failure.kind === "deleted" ? undefined : { label: t("Tentar de novo"), onClick: retry, disabled: busy }}
    />
  )
}

export const getHistoryNoticeCopy = (failure: HistoryFailure): { title: string; cause: string } => {
  if (failure.kind === "offline")
    return { title: t("History failure offline title"), cause: t("History failure offline") }
  if (failure.kind === "deleted")
    return { title: t("History failure deleted title"), cause: t("History failure deleted") }
  if (failure.kind === "restarting")
    return { title: t("History failure title"), cause: t("History failure restarting") }

  return { title: t("History failure title"), cause: t("History failure server") }
}
