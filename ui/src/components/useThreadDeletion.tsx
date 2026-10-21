import { useEffect, useRef, useState } from "react"
import { ApiError } from "../errors"
import { t } from "../i18n"
import type { ThreadDeleteTarget } from "./DeleteThreadDialog"

type DeletionActions = {
  onDeleteThread?: ((threadId: string, botId: string) => Promise<void>) | undefined
  onDeleteThreads?: ((threadIds: Array<string>, botId: string) => Promise<void>) | undefined
}

type PendingDeletion = { id: string; botId: string; targets: Array<ThreadDeleteTarget> }
export type ThreadDeletion = ReturnType<typeof useThreadDeletion>

export const useThreadDeletion = (actions: DeletionActions) => {
  const [pending, setPending] = useState<PendingDeletion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const queue = (botId: string, targets: Array<ThreadDeleteTarget>, onDeleted?: () => void): boolean => {
    if (!targets.length || timer.current) return false
    const ids = targets.map((target) => target.id)
    const id = crypto.randomUUID()
    setError(null)
    timer.current = setTimeout(() => {
      timer.current = null
      setPending(null)
      const removal =
        ids.length === 1 && actions.onDeleteThread
          ? actions.onDeleteThread(ids[0] ?? "", botId)
          : actions.onDeleteThreads?.(ids, botId)
      void removal?.then(onDeleted).catch((cause: unknown) => setError(getThreadDeletionError(cause)))
    }, 5000)
    setPending({ id, botId, targets })
    return true
  }
  const undo = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPending(null)
  }

  return { pending, error, queue, undo, dismiss: () => setError(null) }
}

export const ThreadDeletionNotice = ({ deletion }: { deletion: ThreadDeletion }) => {
  if (deletion.error)
    return (
      <div className="thread-delete-toast" role="alert">
        <span>{deletion.error}</span>
        <button type="button" className="button-quiet" onClick={deletion.dismiss}>
          {t("Dismiss notice")}
        </button>
      </div>
    )
  if (!deletion.pending) return null

  return (
    <div className="thread-delete-toast" role="status" aria-live="polite">
      <span>
        {t(
          deletion.pending.targets.length === 1
            ? "Your conversation will be deleted in 5 seconds."
            : "Your conversations will be deleted in 5 seconds.",
        )}
      </span>
      <button type="button" className="button-quiet" onClick={deletion.undo}>
        {t("Undo")}
      </button>
    </div>
  )
}

export const getThreadDeletionError = (error: unknown): string => {
  const code = error instanceof ApiError ? error.errorCode : undefined
  if (code === "THREAD_ACTIVE") return t("Finish the active run before deleting this conversation.")
  if (code === "THREAD_MAIN") return t("The bot's main conversation can't be deleted.")
  if (code === "THREAD_DELETE_FORBIDDEN") return t("You don't have permission to delete this conversation.")
  if (code === "THREAD_REMOTE") return t("This remote conversation can't be deleted here.")
  if (code === "THREAD_DELETING") return t("This conversation is already being deleted.")
  return t("Could not delete this conversation. Try again.")
}
