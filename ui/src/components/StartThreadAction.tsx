import type { Message, Thread } from "@touri/contracts"
import { useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"

export const StartThreadAction = ({
  message,
  api,
  thread,
  onSelect,
}: {
  message: Message
  api: UiApi
  thread?: Thread | undefined
  onSelect: (id: string) => void
}) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const start = async () => {
    if (busy) return
    if (thread) return onSelect(thread.id)
    setBusy(true)
    setError(false)
    try {
      const response = await api.request(
        "POST /threads/:id/start-thread",
        { messageId: message.id },
        { id: message.threadId },
      )
      onSelect(response.thread.id)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={thread ? "message-thread-replies" : "message-start-thread"}>
      <button type="button" className="text-button" disabled={busy} onClick={() => void start()}>
        {thread
          ? t("{count} respostas", { count: thread.replyCount ?? 0 })
          : t(busy ? "Abrindo thread…" : "Iniciar thread")}
      </button>
      {error && <span role="alert">{t("Não foi possível iniciar a thread. Tente novamente.")}</span>}
    </div>
  )
}
