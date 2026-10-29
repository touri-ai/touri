import {
  type Bot,
  canDeliverNotification,
  isWithinNotificationQuietHours,
  type NotificationPreferences,
  type NotifyKind,
} from "@touri/contracts"

export type NotificationSoundKind = "attention" | "reply" | "task" | "channel"

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
  if (event.systemQuiet) return false
  const onScreen = event.visible && event.focused
  const sameThread = event.threadId !== null && event.threadId === event.activeThreadId
  // A finished channel task is news when the person is elsewhere: another app, a hidden window or another conversation.
  if (event.kind === "channel" ? onScreen && sameThread : !onScreen || sameThread) return false
  if (event.preferences?.enabled === false) return false
  if (event.botId && event.preferences?.bots?.[event.botId]?.enabled === false) return false
  if (isWithinNotificationQuietHours(event.preferences?.quietHours, event.now)) return false
  if (event.kind === "attention" && event.preferences?.sound?.attention === false) return false
  if (event.kind === "task" && event.preferences?.sound?.task === false) return false
  if (event.kind === "reply" && event.preferences?.sound?.replies !== true) return false
  if (event.kind === "channel" && event.preferences?.sound?.channel === false) return false
  if (getNotificationVolume(event.preferences) === 0) return false
  if (!event.notificationKind) return true

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
  sink: (volume: number, kind?: NotificationSoundKind) => void
  now?: () => number
}) => {
  // The timestamp is controller-local state required to coalesce bursty event streams.
  let lastPlayedAt = Number.NEGATIVE_INFINITY

  const play = (event: Omit<NotificationSoundEvent, "now">): boolean => {
    const current = now()
    if (!shouldPlayNotificationSound({ ...event, now: new Date(current) })) return false
    if (current - lastPlayedAt < 3000) return false

    lastPlayedAt = current
    if (event.kind === "task" || event.kind === "channel") sink(getNotificationVolume(event.preferences), event.kind)
    else sink(getNotificationVolume(event.preferences))
    return true
  }

  return { play }
}

const getNotificationVolume = (preferences?: NotificationPreferences): number =>
  Math.max(0, Math.min(100, preferences?.sound?.volume ?? 45)) / 100
