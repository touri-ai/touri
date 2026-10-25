import type { NotificationRecord } from "@touri/contracts"
import type { UiApi } from "./api/client"
import { ApiError } from "./errors"

export const clearNotifications = async (
  api: Pick<UiApi, "request">,
  ids: number[],
  notifications: ReadonlyArray<NotificationRecord>,
  update: (notifications: NotificationRecord[]) => void,
): Promise<{ skipped: number; skippedIds: number[] }> => {
  const result = await api.request("POST /notifications/read", { ids })
  update(result.notifications)
  const skipped = new Set(result.skippedIds)
  const recoveries = notifications.filter((item) => skipped.has(item.id) && isRecoveryNotification(item))
  // Serial requests bound recovery synchronization and preserve each successful partial update.
  const dismissed = await recoveries.reduce<Promise<number[]>>(async (previous, item) => {
    const completed = await previous
    const notification = await dismissRecoveryNotification(api, item.id)
    if (!notification) return completed

    update([notification])
    return completed.concat(item.id)
  }, Promise.resolve([]))
  if (dismissed.length > 0) {
    const read = await api.request("POST /notifications/read", { ids: dismissed })
    update(read.notifications)
  }
  const dismissedIds = new Set(dismissed)
  const skippedIds = result.skippedIds.filter((id) => !dismissedIds.has(id))

  return { skipped: skippedIds.length, skippedIds }
}

export const isRecoveryNotification = (item: NotificationRecord): boolean =>
  (item.kind === "turn-failed" || item.kind === "routine-failed") && item.requestId?.startsWith("recovery:") === true

const dismissRecoveryNotification = async (
  api: Pick<UiApi, "request">,
  id: number,
): Promise<NotificationRecord | null> => {
  try {
    const result = await api.request("POST /notifications/:id/dismiss", {}, { id: String(id) })
    return result.notification
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.errorCode === "ACKNOWLEDGEMENT_REQUIRED") return null

    throw error
  }
}
