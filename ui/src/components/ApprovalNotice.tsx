import type { Message, NotificationRecord } from "@touri/contracts"
import { useState } from "react"
import type { ApprovalTarget } from "../approvalNavigation"
import { approvalBarSummary, approvalNotificationSummary } from "../approvalNotice"
import { isResolvedNotification, reconcileApprovalNotifications } from "../approvalState"
import { t } from "../i18n"

export const ApprovalNotice = ({
  notifications,
  messages,
  onReview,
}: {
  notifications: NotificationRecord[]
  messages: Message[]
  onReview: (target: ApprovalTarget) => void
}) => {
  const [hidden, setHidden] = useState<Set<number>>(() => new Set())
  const item = reconcileApprovalNotifications(notifications, messages)
    .filter(
      (item) =>
        item.kind === "approval" &&
        !isResolvedNotification(item) &&
        !hidden.has(item.id) &&
        item.threadId &&
        item.requestId,
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0]
  if (!item) return null
  const summary = approvalBarSummary(approvalNotificationSummary(item, messages))
  return (
    <div className="notice-bar approval-notice" role="status">
      <span className="notice-content">
        <strong>{item.botName ?? "touri"}: </strong>
        {summary.title} · {summary.body}
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
        onClick={() => setHidden((current) => new Set([...current, item.id]))}
        aria-label={t("Dismiss notice")}
      >
        ×
      </button>
    </div>
  )
}
