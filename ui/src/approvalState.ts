import type { ApprovalPart, Message, NotificationRecord } from "@touri/contracts"
import { t } from "./i18n"

export const resolvedApprovalLabel = (decision: ApprovalPart["decision"]): string =>
  decision === "approved"
    ? t("Aprovado por você")
    : decision === "expired"
      ? t("Aprovação expirada")
      : t("Negado por você")

export const isResolvedNotification = (item: NotificationRecord): boolean =>
  item.resolvedAt !== null ||
  (item.kind === "approval" && ["allow", "deny", "expired", "canceled", "dismissed"].includes(item.resolution ?? ""))

export const reconcileApprovalMessages = (
  messages: Message[],
  notifications: NotificationRecord[],
  snapshot: Message[] = messages,
): Message[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "approval") return part
      const notice = notifications.find(
        (item) =>
          item.kind === "approval" &&
          item.threadId === message.threadId &&
          item.requestId === part.approvalId &&
          ["allow", "deny", "expired", "canceled"].includes(item.resolution ?? ""),
      )
      const peer = snapshot
        .filter((other) => other.threadId === message.threadId)
        .flatMap((other) => other.parts)
        .find(
          (other) => other.type === "approval" && other.approvalId === part.approvalId && other.decision !== "pending",
        )
      if (!notice && peer?.type !== "approval") return part
      return {
        ...part,
        decision:
          part.decision !== "pending"
            ? part.decision
            : peer?.type === "approval"
              ? peer.decision
              : notice?.resolution === "allow"
                ? "approved"
                : notice?.resolution === "expired" || notice?.resolution === "canceled"
                  ? "expired"
                  : "denied",
        ...(notice?.resolvedAt != null || (peer?.type === "approval" && peer.resolvedAt != null)
          ? {
              resolvedAt:
                part.resolvedAt ?? notice?.resolvedAt ?? (peer?.type === "approval" ? peer.resolvedAt : undefined),
            }
          : {}),
      } as ApprovalPart
    }),
  }))

export const reconcileApprovalNotifications = (
  items: NotificationRecord[],
  messages: Message[],
): NotificationRecord[] =>
  items.map((item) => {
    if (item.kind !== "approval") return item
    const resolved = items.find(
      (other) =>
        other.kind === "approval" &&
        other.threadId === item.threadId &&
        other.requestId === item.requestId &&
        item.requestId !== null &&
        ["allow", "deny", "expired", "canceled"].includes(other.resolution ?? ""),
    )
    if (resolved) return { ...item, resolution: resolved.resolution, resolvedAt: resolved.resolvedAt }
    if (item.resolvedAt !== null) return item
    const message = messages.find(
      (message) =>
        message.threadId === item.threadId &&
        message.parts.some(
          (part) => part.type === "approval" && part.approvalId === item.requestId && part.decision !== "pending",
        ),
    )
    const part = message?.parts.find((part) => part.type === "approval" && part.approvalId === item.requestId)
    if (!message || part?.type !== "approval" || part.decision === "pending") return item
    return {
      ...item,
      resolvedAt: part.resolvedAt ?? null,
      resolution: part.decision === "approved" ? "allow" : part.decision === "expired" ? "expired" : "deny",
    }
  })

/** One reminder per request, including duplicate records from older event streams. */
export const uniqueApprovalNotifications = (items: NotificationRecord[]): NotificationRecord[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (item.kind !== "approval" || !item.requestId) return true
    const key = JSON.stringify([item.threadId, item.requestId])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Count requests, not reminders: a hidden or duplicated reminder cannot change a decision. */
export const countPendingRequests = (notifications: NotificationRecord[], messages: Message[]): number => {
  const reconciled = reconcileApprovalMessages(messages, notifications)
  const pending = new Set(
    reconciled.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "approval" && part.decision === "pending"
          ? [JSON.stringify([message.threadId, part.approvalId])]
          : [],
      ),
    ),
  )
  for (const item of reconcileApprovalNotifications(notifications, reconciled))
    if ((item.kind === "approval" || item.kind === "question") && item.requestId && !isResolvedNotification(item))
      pending.add(JSON.stringify([item.threadId, item.requestId]))
  return pending.size
}
