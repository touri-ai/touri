import type { Id, Message } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { composerKeyAction } from "../composerKeys"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import "./message-actions.css"

export type EditMessage = (text: string, parentId: Id | null, attachmentIds: Id[]) => Promise<void>

export const UserMessageEdit = ({
  message,
  onEdit,
  disabled,
}: {
  message: Message
  onEdit: EditMessage
  disabled: boolean
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])
  const cancel = () => {
    setEditing(false)
    button.current?.focus()
  }
  const submit = async () => {
    if (disabled || submitting.current || !draft.trim()) return
    submitting.current = true
    setSaving(true)
    setError(null)
    try {
      await onEdit(
        draft.trim(),
        message.parentId,
        message.parts.flatMap((part) => (part.type === "file" || part.type === "image" ? [part.attachmentId] : [])),
      )
      setEditing(false)
      button.current?.focus()
    } catch (reason) {
      setError(t("Não foi possível enviar. {reason}", { reason: userFacingError(reason) }))
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }
  return (
    <div className="user-message-actions">
      <button
        ref={button}
        type="button"
        className="text-button"
        disabled={disabled || saving}
        aria-expanded={editing}
        onClick={() => {
          setDraft(message.text)
          setError(null)
          setEditing(true)
        }}
      >
        {t("Editar")}
      </button>
      {editing && (
        <form
          className="user-message-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <p>{t("Ao enviar, uma nova ramificação será criada. A mensagem original será mantida.")}</p>
          <textarea
            ref={input}
            aria-label={t("Editar mensagem")}
            value={draft}
            disabled={saving}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !saving) {
                event.preventDefault()
                cancel()
              } else if (composerKeyAction({ ...event, isComposing: event.nativeEvent.isComposing }) === "send") {
                event.preventDefault()
                void submit()
              }
            }}
          />
          {error && <p role="alert">{error}</p>}
          <div>
            <button type="button" className="button button-quiet" disabled={saving} onClick={cancel}>
              {t("Cancelar")}
            </button>
            <button type="submit" className="button button-brand" disabled={disabled || saving || !draft.trim()}>
              {saving ? t("Enviando…") : t("Salvar e enviar")}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
