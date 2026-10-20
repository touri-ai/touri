import {
  type Bot,
  canDeliverNotification,
  type NotificationPreferences,
  type NotificationRecord,
} from "@touri/contracts"
import { useEffect, useRef } from "react"
import type { TauriInvoke, UiApi } from "../../api/client"
import { buildDeepLink } from "../../deepLink"
import { localizeNotice, t } from "../../i18n"
import { isAttention, pendingNotifications } from "../../sidebarAttention"
import type { WorkspaceData } from "../../useWorkspace"

const validId = (value: string | null | undefined) => (value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null)

/** Alert only for new event records. Snapshots restore badges without replaying historical alerts. */
export const installServerAttention = (
  api: UiApi,
  invoke: TauriInvoke,
  options: {
    initial: ReadonlyArray<NotificationRecord>
    enabled: () => boolean
    botForThread: (thread: string) => string | null
    preferences?: () => NotificationPreferences | undefined
    botPreference?: (botId: string | null) => Bot["notifications"] | null
    startedAt?: number
  },
) => {
  const startedAt = options.startedAt ?? Date.now()
  const initialLastId = options.initial.reduce((maximum, item) => Math.max(maximum, item.id), 0)
  const seenIds = new Set(options.initial.map((item) => item.id))
  let lastSeq = 0
  return api.subscribe(({ seq, at, event }) => {
    if (event.type === "transcript.resync") {
      lastSeq = 0
      return
    }
    if (seq <= lastSeq) return
    lastSeq = seq
    if (!options.enabled()) return
    let result = false
    let title: string
    let bot: string | null
    let thread: string | null
    if (event.type === "notification.created") {
      const note = event.notification
      if (note.id <= initialLastId || seenIds.has(note.id)) return
      seenIds.add(note.id)
      if (seenIds.size > 2048) {
        const oldest = seenIds.values().next().value
        if (oldest !== undefined) seenIds.delete(oldest)
      }
      if (note.resolvedAt !== null) return
      if (!options.preferences && !isAttention(note) && note.kind !== "notice") return
      if (
        !canDeliverNotification({
          notification: note,
          preferences: options.preferences?.(),
          botPreference: options.botPreference?.(note.botId) ?? null,
        })
      )
        return
      result = !isAttention(note)
      title = note.title
      thread = validId(note.threadId)
      bot = validId(note.botId) ?? (thread ? validId(options.botForThread(thread)) : null)
    } else if (event.type === "notify") {
      if (at < startedAt) return
      // Persisted notification records arrive separately; avoid their legacy host echo.
      if (
        event.notificationId !== undefined ||
        event.requestId ||
        event.kind === "done" ||
        event.kind === "delegation-settled"
      )
        return
      if (!event.kind && event.level === "info") return
      title = event.title
      thread = validId(event.threadId)
      bot = thread ? validId(options.botForThread(thread)) : null
      if (
        !canDeliverNotification({
          notification: { kind: event.kind ?? "incident", botId: bot },
          preferences: options.preferences?.(),
          botPreference: options.botPreference?.(bot) ?? null,
        })
      )
        return
    } else return
    const notificationId = event.type === "notification.created" ? event.notification.id : event.notificationId
    void invoke("server_attention", {
      title: localizeNotice(title).slice(0, 120),
      body: t(result ? "Há um novo aviso na central de notificações." : "Um bot precisa da sua atenção."),
      ...(bot || thread || notificationId !== undefined
        ? {
            deepLink: buildDeepLink({ bot, thread, ...(notificationId === undefined ? {} : { notificationId }) }),
          }
        : {}),
    }).catch(() => undefined)
  })
}

export const useServerAttention = ({
  api,
  invoke,
  enabled,
  data,
}: {
  api: UiApi | null
  invoke: TauriInvoke
  enabled: boolean
  data: WorkspaceData
}) => {
  const latest = useRef(data)
  latest.current = data
  useEffect(() => {
    if (!enabled || !api || data.loading) return
    return installServerAttention(api, invoke, {
      initial: latest.current.notifications,
      enabled: () => latest.current.settings?.nativeNotifications !== false,
      preferences: () => latest.current.settings?.notificationPreferences,
      botPreference: (botId) => latest.current.bots.find((bot) => bot.id === botId)?.notifications ?? null,
      botForThread: (thread) => latest.current.threads.find((item) => item.id === thread)?.botId ?? null,
    })
  }, [api, invoke, enabled, data.loading])
  const count = pendingNotifications(data.notifications, data.activityMessages, data.runs).length
  useEffect(() => {
    if (enabled && !data.loading) void invoke("server_badge", { count: Math.min(9999, count) }).catch(() => undefined)
  }, [invoke, enabled, count, data.loading])
}
