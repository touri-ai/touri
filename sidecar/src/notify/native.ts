import { type Bot, canDeliverNotification, type NotificationRecord } from "@touri/contracts"

/** Whether a notification should raise an OS notification, given the bot's `notifications` preference. */
export const shouldNotifyNative = ({
  notification,
  preference,
}: {
  notification: NotificationRecord
  preference: Bot["notifications"] | null
}): boolean => canDeliverNotification({ notification, botPreference: preference })

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
