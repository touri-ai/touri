import { useId } from "react"
import { t } from "../i18n"
import { Modal } from "./Modal"

export type ThreadDeleteTarget = { id: string; title: string; messageCount: number | null }

export const DeleteThreadDialog = ({
  targets,
  onConfirm,
  onClose,
}: {
  targets: Array<ThreadDeleteTarget>
  onConfirm: () => void
  onClose: () => void
}) => {
  const descriptionId = useId()
  const single = targets.length === 1 ? targets[0] : undefined
  const counts = targets.flatMap((target) => (target.messageCount === null ? [] : [target.messageCount]))
  const totalMessages = counts.length === targets.length ? counts.reduce((total, count) => total + count, 0) : null
  const title = single
    ? t("Delete “{title}”?", { title: single.title })
    : t("Delete {count} conversations", { count: targets.length })

  return (
    <Modal
      role="alertdialog"
      title={title}
      describedBy={descriptionId}
      className="delete-thread-dialog"
      onClose={onClose}
    >
      <div className="delete-thread-dialog-body">
        <div className="delete-thread-dialog-copy" id={descriptionId}>
          {single ? (
            <>
              <p>{single.title}</p>
              <p>
                {single.messageCount === null
                  ? t("This removes the conversation and its unused attachments.")
                  : t("This removes {count} messages and their unused attachments.", { count: single.messageCount })}
              </p>
            </>
          ) : (
            <>
              <p>{t("{count} conversations found.", { count: targets.length })}</p>
              {totalMessages !== null && (
                <p>{t("These conversations contain {count} messages in total.", { count: totalMessages })}</p>
              )}
              <ul>
                {targets.slice(0, 5).map((target) => (
                  <li key={target.id}>
                    {target.title}
                    {target.messageCount !== null && ` · ${target.messageCount}`}
                  </li>
                ))}
                {targets.length > 5 && <li>{t("+ {count} more", { count: targets.length - 5 })}</li>}
              </ul>
            </>
          )}
        </div>
        <p>{t("Deleting stops any active work in these conversations.")}</p>
        <p className="field-help">{t("You can undo for 5 seconds.")}</p>
      </div>
      <div className="modal-actions">
        <button type="button" data-initial-focus className="button-quiet" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button type="button" className="tool-action tool-action-deny" onClick={onConfirm}>
          {t("Delete")}
        </button>
      </div>
    </Modal>
  )
}
