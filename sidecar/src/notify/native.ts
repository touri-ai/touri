import { type Bot, canDeliverNotification, type NotificationRecord } from "@touri/contracts"

/** Whether a notification should raise an OS notification, given the bot's `notifications` preference. */
export const shouldNotifyNative = ({
  notification,
  preference,
}: {
  notification: NotificationRecord
  preference: Bot["notifications"] | null
}): boolean => canDeliverNotification({ notification, botPreference: preference })

export const buildDeepLink = ({
  botId,
  threadId,
  notificationId,
}: {
  botId: string | null
  threadId: string | null
  notificationId?: number
}): string => {
  const params = new URLSearchParams()
  if (botId) params.set("bot", botId)
  if (threadId) params.set("thread", threadId)
  if (notificationId !== undefined && Number.isSafeInteger(notificationId) && notificationId > 0)
    params.set("notification", String(notificationId))
  return `touri://open?${params.toString()}`
}

export const nativeNotificationTitle = (notification: NotificationRecord): string => {
  if (notification.kind !== "approval")
    return notification.botName ? `${notification.botName}: ${notification.title}` : notification.title
  const action = (notification.body.trim() || notification.title).replace(/\.$/, "")
  return `${notification.botName ?? "touri"} precisa de você: autorizar ${action.charAt(0).toLocaleLowerCase()}${action.slice(1)}.`
}

/** Only application-authored keys are translated; bot content keeps its original language. */
export const getNativeNotificationBody = (
  notification: NotificationRecord,
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
): string => {
  if (notification.body !== "Routine finished with no news.") return notification.body
  if (locale.startsWith("pt")) return "Rotina concluída sem novidades."

  return "Routine finished with no news."
}
