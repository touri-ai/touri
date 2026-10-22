import type { BotGroup } from "@touri/contracts"
import { useId, useState } from "react"
import { ApiError, userFacingError } from "../errors"
import { type Locale, t } from "../i18n"
import { Modal } from "./Modal"

export const DeleteGroupDialog = ({
  group,
  onDelete,
  onClose,
  locale = "pt-BR",
  channelMode = false,
}: {
  group: BotGroup
  onDelete: (groupId: string) => Promise<void>
  onClose: () => void
  locale?: Locale
  channelMode?: boolean
}) => {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const descriptionId = useId()
  const remove = async () => {
    if (busy || name !== group.name) return

    setBusy(true)
    setError(null)
    try {
      await onDelete(group.id)
      onClose()
    } catch (error) {
      setError(
        error instanceof ApiError && error.errorCode === "GROUP_BUSY"
          ? t(
              channelMode
                ? "Aguarde as respostas do canal terminarem ou cancele os turnos antes de apagar o canal."
                : "Aguarde as respostas terminarem ou cancele os turnos antes de apagar o grupo.",
              {},
              locale,
            )
          : userFacingError(error),
      )
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t(channelMode ? "Delete channel dialog title" : "Apagar grupo", {}, locale)}
      eyebrow={group.name}
      describedBy={descriptionId}
      className="delete-group-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="modal-form">
        <p id={descriptionId}>
          {t(
            channelMode
              ? "Apagar {name} remove todas as conversas, mensagens e rotinas do canal. Esta ação não pode ser desfeita."
              : "Apagar {name} remove todas as conversas, mensagens e rotinas do grupo. Esta ação não pode ser desfeita.",
            {
              name: group.name,
            },
            locale,
          )}
        </p>
        <p className="field-help">{t("Os bots e suas conversas individuais são preservados.", {}, locale)}</p>
        <label htmlFor={nameId}>
          {t(
            channelMode ? "Type channel name: {name}" : "Digite o nome do grupo: {name}",
            { name: group.name },
            locale,
          )}
        </label>
        <input
          id={nameId}
          data-initial-focus
          value={name}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>
          {t("Cancelar", {}, locale)}
        </button>
        <button
          type="button"
          className="tool-action tool-action-deny"
          disabled={busy || name !== group.name}
          onClick={() => void remove()}
        >
          {t(
            channelMode
              ? busy
                ? "Deleting channel…"
                : "Delete channel dialog title"
              : busy
                ? "Apagando grupo…"
                : "Apagar grupo",
            {},
            locale,
          )}
        </button>
      </div>
    </Modal>
  )
}
