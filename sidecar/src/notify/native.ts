import type { Bot, NotificationRecord } from "@touri/contracts"
import { ATTENTION_KINDS, BLOCKING_KINDS } from "./kinds"

/** Whether a notification should raise an OS notification, given the bot's `notifications` preference. */
export const shouldNotifyNative = ({
  notification,
  preference,
}: {
  notification: NotificationRecord
  preference: Bot["notifications"] | null
}): boolean => {
  if (preference === "none") return BLOCKING_KINDS.has(notification.kind)
  if (ATTENTION_KINDS.has(notification.kind)) return true
  return preference === "all"
}

export const buildDeepLink = ({ botId, threadId }: { botId: string | null; threadId: string | null }): string => {
  const params = new URLSearchParams()
  if (botId) params.set("bot", botId)
  if (threadId) params.set("thread", threadId)
  return `touri://open?${params.toString()}`
}

export const nativeNotificationTitle = (notification: NotificationRecord): string => {
  if (notification.kind !== "approval")
    return notification.botName ? `${notification.botName}: ${notification.title}` : notification.title
  const action = (notification.body.trim() || notification.title).replace(/\.$/, "")
  return `${notification.botName ?? "touri"} precisa de você: autorizar ${action.charAt(0).toLocaleLowerCase()}${action.slice(1)}.`
}
