import type { Routine } from "@touri/contracts"
import { useId, useRef, useState } from "react"
import { t } from "../i18n"
import { Modal } from "./Modal"
import "./delete-routine.css"

export const DeleteRoutineDialog = ({
  routine,
  onDelete,
  onClose,
  onDeleted,
}: {
  routine: Pick<Routine, "id" | "name">
  onDelete: (routineId: string) => Promise<void>
  onClose: () => void
  onDeleted?: () => void
}) => {
  const descriptionId = useId()
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const remove = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(false)
    try {
      await onDelete(routine.id)
      onClose()
      onDeleted?.()
    } catch {
      busyRef.current = false
      setBusy(false)
      setError(true)
    }
  }
  return (
    <Modal
      role="alertdialog"
      title={t("Excluir a rotina {name}?", { name: routine.name })}
      describedBy={descriptionId}
      className="delete-routine-dialog"
      onClose={() => {
        if (!busyRef.current) onClose()
      }}
    >
      <p id={descriptionId}>{t("Ela não vai mais rodar. O histórico de execuções continua nas conversas.")}</p>
      {error && <p role="alert">{t("Não foi possível excluir a rotina. Tente novamente.")}</p>}
      <div className="modal-actions">
        <button type="button" data-initial-focus className="button-quiet" disabled={busy} onClick={onClose}>
          {t("Cancelar")}
        </button>
        <button
          type="button"
          className="routine-delete-button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void remove()}
        >
          {busy ? t("Excluindo…") : t("Excluir")}
        </button>
      </div>
    </Modal>
  )
}
