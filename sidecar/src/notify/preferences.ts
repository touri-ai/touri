import type { Database } from "bun:sqlite"
import { isNotificationPreferences, type NotificationPreferences } from "@touri/contracts"

export const getNotificationSettings = (db: Database): { enabled: boolean; preferences?: NotificationPreferences } => {
  const rows = db
    .query("SELECT key, value_json FROM settings WHERE key IN ('nativeNotifications', 'notificationPreferences')")
    .all() as Array<{ key: string; value_json: string }>
  const enabled = rows.find((row) => row.key === "nativeNotifications")?.value_json !== "false"
  const saved = rows.find((row) => row.key === "notificationPreferences")
  if (!saved) return { enabled }

  try {
    const preferences: unknown = JSON.parse(saved.value_json)
    return isNotificationPreferences(preferences)
      ? { enabled, preferences: getLocalNotificationPreferences(preferences) }
      : { enabled }
  } catch {
    return { enabled }
  }
}

/** Remote screens use the host clock too, even when the phone is in a different time zone. */
export const getLocalNotificationPreferences = (preferences: NotificationPreferences): NotificationPreferences => {
  if (!preferences.quietHours) return preferences

  return {
    ...preferences,
    quietHours: { ...preferences.quietHours, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  }
}
