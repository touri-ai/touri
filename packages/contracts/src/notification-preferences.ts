import type { Bot, NotificationPreferences, NotifyInput, NotifyKind } from "./types"

/** Delivery policy only: filtered and quiet notifications must still be saved and counted. */
export const canDeliverNotification = ({
  notification,
  preferences,
  enabled = true,
  botPreference = null,
  now = new Date(),
}: {
  notification: Pick<NotifyInput, "kind" | "botId">
  preferences?: NotificationPreferences | undefined
  enabled?: boolean
  botPreference?: Bot["notifications"] | null
  now?: Date
}): boolean => {
  if (!enabled || preferences?.enabled === false) return false

  const bot = notification.botId ? preferences?.bots?.[notification.botId] : undefined
  if (bot?.enabled === false) return false
  if (isBlockingNotificationKind(notification.kind)) return true
  if (isWithinNotificationQuietHours(preferences?.quietHours, now)) return false

  const typeEnabled = bot?.types?.[notification.kind] ?? preferences?.types?.[notification.kind]
  if (typeEnabled !== undefined) return typeEnabled

  const digest = bot?.digest ?? preferences?.digest
  if (digest) return digest === "all" || !RESULT_KINDS.includes(notification.kind)
  if (botPreference === "none") return false

  return !RESULT_KINDS.includes(notification.kind) || botPreference === "all"
}

export const isNotificationPreferences = (value: unknown): value is NotificationPreferences => {
  const preferences = getRecord(value)
  if (!preferences || !isScopePreferences(preferences, ["bots", "quietHours", "sound"])) return false

  const bots = getRecord(preferences.bots)
  if (preferences.bots !== undefined && (!bots || !Object.values(bots).every((bot) => isScopePreferences(bot))))
    return false
  if (preferences.quietHours !== undefined && !isQuietHoursPreferences(preferences.quietHours)) return false
  if (preferences.sound !== undefined && !isSoundPreferences(preferences.sound)) return false

  return true
}

export const NOTIFICATION_KINDS: readonly NotifyKind[] = [
  "approval",
  "question",
  "takeover",
  "turn-failed",
  "routine-failed",
  "routine-deferred",
  "delegation-settled",
  "incident",
  "done",
  "notice",
]

const RESULT_KINDS: readonly NotifyKind[] = ["done", "delegation-settled"]
export const isBlockingNotificationKind = (kind: NotifyKind): boolean =>
  kind === "approval" || kind === "question" || kind === "takeover"

export const isWithinNotificationQuietHours = (quiet: NotificationPreferences["quietHours"], now: Date): boolean => {
  if (!quiet?.enabled) return false

  const minutes = quiet.timeZone
    ? getClockMinutes(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: quiet.timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(now),
      )
    : now.getHours() * 60 + now.getMinutes()
  const start = getClockMinutes(quiet.start)
  const end = getClockMinutes(quiet.end)
  if (start === end) return true
  if (start < end) return minutes >= start && minutes < end

  return minutes >= start || minutes < end
}

const isQuietHoursPreferences = (value: unknown): boolean => {
  const quiet = getRecord(value)
  return (
    !!quiet &&
    Object.keys(quiet).every((key) => ["enabled", "start", "end", "timeZone"].includes(key)) &&
    typeof quiet.enabled === "boolean" &&
    isClockTime(quiet.start) &&
    isClockTime(quiet.end) &&
    (quiet.timeZone === undefined || isTimeZone(quiet.timeZone))
  )
}

const isSoundPreferences = (value: unknown): boolean => {
  const sound = getRecord(value)
  return (
    !!sound &&
    Object.keys(sound).every((key) => ["attention", "replies", "volume"].includes(key)) &&
    (sound.attention === undefined || typeof sound.attention === "boolean") &&
    (sound.replies === undefined || typeof sound.replies === "boolean") &&
    (sound.volume === undefined || (typeof sound.volume === "number" && sound.volume >= 0 && sound.volume <= 100))
  )
}

const getClockMinutes = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number)
  return hours * 60 + minutes
}

const isClockTime = (value: unknown): value is string =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

const getRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const isScopePreferences = (value: unknown, extraKeys: readonly string[] = []): boolean => {
  const scope = getRecord(value)
  if (!scope || !Object.keys(scope).every((key) => ["enabled", "digest", "types", ...extraKeys].includes(key)))
    return false
  if (scope.enabled !== undefined && typeof scope.enabled !== "boolean") return false
  if (scope.digest !== undefined && scope.digest !== "attention" && scope.digest !== "all") return false
  if (scope.types === undefined) return true

  const types = getRecord(scope.types)
  return (
    !!types &&
    Object.entries(types).every(
      ([kind, enabled]) => NOTIFICATION_KINDS.includes(kind as NotifyKind) && typeof enabled === "boolean",
    )
  )
}

const isTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string") return false

  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value })
    return true
  } catch {
    return false
  }
}
