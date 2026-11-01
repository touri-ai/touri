import type { Message, Thread } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
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
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  const start = async () => {
    if (request.current) return
    if (thread && !thread.archivedAt) return onSelect(thread.id)
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(false)
    try {
      const response = await api.request(
        "POST /threads/:id/start-thread",
        { messageId: message.id },
        { id: message.threadId },
        { signal: controller.signal },
      )
      if (controller.signal.aborted) return
      onSelect(response.thread.id)
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const count = thread?.replyCount ?? 0
  const replies = count === 1 ? t("1 resposta") : t("{count} respostas", { count })

  return (
    <div className={thread ? "message-thread-replies" : "message-start-thread"}>
      <button type="button" className="text-button" disabled={busy} onClick={() => void start()}>
        {thread ? replies : t(busy ? "Abrindo thread…" : "Iniciar thread")}
      </button>
      {error && <span role="alert">{t("Não foi possível iniciar a thread. Tente novamente.")}</span>}
    </div>
  )
}
