import type { NotificationRecord } from "./types"

/** Clearing recent information must never hide work that still needs a decision or recovery. */
export const canMarkNotificationRead = (notification: NotificationRecord): boolean => {
  if (notification.resolvedAt !== null) return true
  if (notification.requestId?.startsWith("recovery:")) return false
  if (notification.kind === "notice") return !notification.requestId?.startsWith("pr-ready:")

  return ["done", "delegation-settled", "task-started", "routine-deferred"].includes(notification.kind)
}
