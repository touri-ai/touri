import {
  type Bot,
  canDeliverNotification,
  isWithinNotificationQuietHours,
  type NotificationPreferences,
  type NotifyKind,
} from "@touri/contracts"

export type NotificationSoundKind = "attention" | "reply"

export type NotificationSoundEvent = {
  kind: NotificationSoundKind
  botId: string | null
  notificationKind?: NotifyKind
  botPreference?: Bot["notifications"] | null
  threadId: string | null
  preferences?: NotificationPreferences | undefined
  activeThreadId: string | null
  visible: boolean
  focused: boolean
  systemQuiet: boolean
  now: Date
}

export const shouldPlayNotificationSound = (event: NotificationSoundEvent): boolean => {
  if (!event.visible || !event.focused || event.systemQuiet) return false
  if (event.threadId !== null && event.threadId === event.activeThreadId) return false
  if (event.preferences?.enabled === false) return false
  if (event.botId && event.preferences?.bots?.[event.botId]?.enabled === false) return false
  if (isWithinNotificationQuietHours(event.preferences?.quietHours, event.now)) return false
  if (event.kind === "attention" && event.preferences?.sound?.attention === false) return false
  if (event.kind === "reply" && event.preferences?.sound?.replies !== true) return false
  if (getNotificationVolume(event.preferences) === 0) return false
  if (event.kind !== "attention" || !event.notificationKind) return true

  return canDeliverNotification({
    notification: { kind: event.notificationKind, botId: event.botId },
    preferences: event.preferences,
    botPreference: event.botPreference ?? null,
    now: event.now,
  })
}

/** One controller belongs to one app session so bursts share the same debounce window. */
export const createNotificationSoundController = ({
  sink,
  now = Date.now,
}: {
  sink: (volume: number) => void
  now?: () => number
}) => {
  // The timestamp is controller-local state required to coalesce bursty event streams.
  let lastPlayedAt = Number.NEGATIVE_INFINITY

  const play = (event: Omit<NotificationSoundEvent, "now">): boolean => {
    const current = now()
    if (!shouldPlayNotificationSound({ ...event, now: new Date(current) })) return false
    if (current - lastPlayedAt < 3000) return false

    lastPlayedAt = current
    sink(getNotificationVolume(event.preferences))
    return true
  }

  return { play }
}

const getNotificationVolume = (preferences?: NotificationPreferences): number =>
  Math.max(0, Math.min(100, preferences?.sound?.volume ?? 45)) / 100
