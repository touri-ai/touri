import type { Thread } from "@touri/contracts"
import { useMemo, useState } from "react"
import { t } from "../i18n"
import { Modal } from "./Modal"

const DAY = 24 * 60 * 60_000

export const DeleteOldAutomaticThreadsDialog = ({
  threads,
  onContinue,
  onClose,
}: {
  threads: Array<Thread>
  onContinue: (days: number, threads: Array<Thread>) => void
  onClose: () => void
}) => {
  const [daysValue, setDaysValue] = useState("30")
  const days = Number(daysValue)
  const validDays = Number.isSafeInteger(days) && days >= 1 && days <= 3650
  const cutoff = Date.now() - (validDays ? days : 0) * DAY
  const candidates = useMemo(() => threads.filter((thread) => thread.updatedAt < cutoff), [threads, cutoff])

  return (
    <Modal
      role="dialog"
      title={t("Delete old automatic conversations")}
      className="delete-thread-dialog"
      onClose={onClose}
    >
      <div className="delete-thread-dialog-body">
        <p>{t("Automatic conversations older than {days} days", { days: validDays ? days : 30 })}</p>
        <label className="delete-old-automatic-days">
          {t("Older than")}
          <input
            data-initial-focus
            type="number"
            min={1}
            max={3650}
            value={daysValue}
            onChange={(event) => setDaysValue(event.currentTarget.value)}
          />
          {t("days")}
        </label>
        <p role="status">
          {candidates.length
            ? t("{count} conversations found.", { count: candidates.length })
            : t("No old automatic conversations.")}
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="button-quiet" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          className="tool-action tool-action-deny"
          disabled={!validDays || candidates.length === 0}
          onClick={() => onContinue(days, candidates)}
        >
          {t("Continue")}
        </button>
      </div>
    </Modal>
  )
}
