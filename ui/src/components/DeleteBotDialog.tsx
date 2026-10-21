import type { Bot } from "@touri/contracts"
import { useState } from "react"
import { getDocumentLocale } from "../documentLanguage"
import { ApiError, userFacingError } from "../errors"
import { t } from "../i18n"
import { Modal } from "./Modals"

export const DeleteBotDialog = ({
  bot,
  onDelete,
  onClose,
}: {
  bot: Bot
  onDelete: (botId: string, name: string, deleteVolumes: boolean) => Promise<void>
  onClose: () => void
}) => {
  const [name, setName] = useState("")
  const [deleteVolumes, setDeleteVolumes] = useState(bot.machine === "cloud")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (busy || name !== bot.name) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(bot.id, name, deleteVolumes)
      onClose()
    } catch (error) {
      setError(
        error instanceof ApiError && error.code === "TOURI-E1004"
          ? t(
              "No modo servidor, somente administradores podem excluir bots.",
              {},
              getDocumentLocale(document.documentElement),
            )
          : userFacingError(error),
      )
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Excluir bot"
      eyebrow={bot.name}
      className="delete-bot-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className="delete-bot-content">
        <p>Excluir {bot.name} remove os dados abaixo. Esta ação não pode ser desfeita.</p>
        <ul>
          <li>Conversas de todos os ramos, histórico de reconexão, turnos, rotinas e notificações deste bot.</li>
          <li>Anexos e saídas de ferramentas que não são usados por outros bots ou conversas.</li>
          <li>Pasta local do bot, SOUL, MEMORY, memória, skills e sessões importadas pertencentes ao bot.</li>
          <li>Arquivos de configuração gerados e logins de Claude e Codex deste bot no cofre.</li>
          {bot.machine !== "local" && (
            <li>Computador do bot. Os volumes só são apagados se você marcar a opção abaixo.</li>
          )}
        </ul>
        <p className="field-help">
          Projetos e suas pastas compartilhadas, segredos de projetos e logins pessoais dos CLIs ficam preservados.
        </p>
        <p className="field-help">
          {t(
            "Se o touri estiver em modo servidor, apenas administradores podem excluir bots.",
            {},
            getDocumentLocale(document.documentElement),
          )}
        </p>
        <label htmlFor="delete-bot-name">Digite o nome do bot: {bot.name}</label>
        <input
          id="delete-bot-name"
          data-initial-focus
          value={name}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        {bot.machine !== "local" && (
          <label className="delete-bot-files">
            <input
              type="checkbox"
              checked={deleteVolumes}
              disabled={busy || bot.machine === "cloud"}
              onChange={(event) => setDeleteVolumes(event.target.checked)}
            />
            <span>apagar também os arquivos do computador</span>
          </label>
        )}
        {bot.machine !== "local" && (
          <p className="field-help">
            {bot.machine === "cloud"
              ? "Na nuvem, excluir o computador também apaga seus arquivos."
              : "Desmarcado: os volumes com os arquivos ficam preservados."}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" className="button-quiet" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="tool-action tool-action-deny"
          disabled={busy || name !== bot.name}
          onClick={() => void remove()}
        >
          {busy ? "Excluindo…" : "Excluir bot"}
        </button>
      </div>
    </Modal>
  )
}
