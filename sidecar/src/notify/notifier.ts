import type { Database } from "bun:sqlite"
import type { Kernel, NotificationRecord, NotifyInput, NotifyResolution } from "@touri/contracts"
import { buildDeepLink, nativeNotificationTitle, shouldNotifyNative } from "./native"
import { getRecoveryAcknowledgementKeys } from "./recovery"
import type { SseHub } from "./sse"
import type { NotificationStore } from "./store"

const MAX_TITLE = 200
const MAX_BODY = 2000

const clip = ({ value, max }: { value: string; max: number }): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

const nativeEnabled = (kernel: Kernel): boolean => {
  const row = (kernel.db as Database)
    .query("SELECT value_json FROM settings WHERE key = 'nativeNotifications'")
    .get() as {
    value_json: string
  } | null
  return row === null || row.value_json !== "false"
}

export const createNotifier = ({ kernel, store, hub }: { kernel: Kernel; store: NotificationStore; hub: SseHub }) => {
  const sendNative = (notification: NotificationRecord): void => {
    if (!nativeEnabled(kernel)) return
    const bot = notification.botId
      ? (kernel.services.use("store.api")?.getBot({ botId: notification.botId }) ?? null)
      : null
    if (!shouldNotifyNative({ notification, preference: bot?.notifications ?? null })) return
    void kernel.callHost("notify", {
      title: clip({ value: nativeNotificationTitle(notification), max: MAX_TITLE }),
      body: notification.body,
      threadId: notification.threadId,
      requestId: notification.requestId,
      notificationId: notification.id,
      kind: notification.kind,
      onlyWhenUnfocused: true,
      deepLink: buildDeepLink({ botId: notification.botId, threadId: notification.threadId }),
    })
  }

  const emit = (input: NotifyInput, options: { silent?: boolean } = {}): NotificationRecord => {
    const threadId = input.threadId
      ? (kernel.services.use("store.api")?.getThread({ threadId: input.threadId })?.groupThreadId ?? input.threadId)
      : null
    const existing = input.requestId ? store.byRequestId(input.requestId) : null
    if (existing && existing.kind === input.kind && existing.threadId === threadId) return existing
    const { notification, seq } = store.insert({
      ...input,
      threadId,
      title: clip({ value: kernel.redact(input.title), max: MAX_TITLE }),
      body: clip({ value: kernel.redact(input.body), max: MAX_BODY }),
    })
    kernel.publish({ type: "notification.created", notification })
    hub.broadcast({ seq, type: "notify", notification })
    if (!options.silent) sendNative(notification)
    return notification
  }

  const finish = ({ id, resolution }: { id: number; resolution: NotifyResolution }): NotificationRecord | null => {
    if (getRecoveryAcknowledgementKeys(kernel.db as Database, id).length > 0) return null
    const resolved = store.resolve({ id, resolution })
    if (!resolved) return null
    kernel.publish({ type: "notification.resolved", notification: resolved.notification })
    hub.broadcast({ seq: resolved.seq, type: "resolved", notification: resolved.notification })
    return resolved.notification
  }

  const resolveRequest = ({
    requestId,
    resolution,
  }: {
    requestId: string
    resolution: NotifyResolution
  }): NotificationRecord | null => {
    const found = store.byRequestId(requestId)
    if (!found) return null
    const matches = found.threadId
      ? store.unresolvedForThread({ threadId: found.threadId, kinds: [found.kind] })
      : [found]
    for (const item of matches) if (item.requestId === requestId) finish({ id: item.id, resolution })
    return store.byRequestId(requestId)
  }

  return { emit, finish, resolveRequest }
}

export type Notifier = ReturnType<typeof createNotifier>
