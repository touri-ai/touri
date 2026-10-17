import type { Message, NotificationRecord } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import type { ApprovalTarget } from "../approvalNavigation"
import { approvalNotificationSummary } from "../approvalNotice"
import { isResolvedNotification, reconcileApprovalNotifications, uniqueApprovalNotifications } from "../approvalState"
import { t } from "../i18n"

const key = (item: NotificationRecord) => JSON.stringify([item.threadId, item.requestId])

export const ApprovalNotice = ({
  notifications,
  messages,
  onReview,
}: {
  notifications: NotificationRecord[]
  messages: Message[]
  onReview: (target: ApprovalTarget) => void
}) => {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [confirmed, setConfirmed] = useState<number | null>(null)
  const previous = useRef(new Set<string>())
  const reconciled = uniqueApprovalNotifications(reconcileApprovalNotifications(notifications, messages))
  useEffect(() => {
    const items = reconcileApprovalNotifications(notifications, messages)
    if (
      items.some((item) => item.kind === "approval" && item.resolution === "allow" && previous.current.has(key(item)))
    )
      setConfirmed(Date.now())
    previous.current = new Set(
      items.filter((item) => item.kind === "approval" && !isResolvedNotification(item)).map(key),
    )
  }, [notifications, messages])
  useEffect(() => {
    if (confirmed === null) return
    const timer = setTimeout(() => setConfirmed(null), 4_000)
    return () => clearTimeout(timer)
  }, [confirmed])
  const item = reconciled
    .filter(
      (item) =>
        item.kind === "approval" &&
        !isResolvedNotification(item) &&
        !hidden.has(key(item)) &&
        item.threadId &&
        item.requestId,
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0]
  if (!item)
    return confirmed !== null ? (
      <div className="notice-bar approval-notice" role="status">
        {t("Autorizado. Retomando a tarefa.")}
      </div>
    ) : null
  const summary = approvalNotificationSummary(item, messages)
  return (
    <div className="notice-bar approval-notice" role="status">
      <span className="notice-content">
        {t("{bot} precisa de você: autorizar {action}.", {
          bot: item.botName ?? "touri",
          action: summary.body.charAt(0).toLocaleLowerCase() + summary.body.slice(1),
        })}
      </span>
      <button
        type="button"
        className="notice-review"
        onClick={() => {
          if (item.threadId && item.requestId) onReview({ threadId: item.threadId, approvalId: item.requestId })
        }}
      >
        {t("Revisar")}
      </button>
      <button
        type="button"
        onClick={() => setHidden((current) => new Set([...current, key(item)]))}
        aria-label={t("Dismiss notice")}
      >
        ×
      </button>
    </div>
  )
}
