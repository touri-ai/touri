import type { TauriInvoke } from "./api/client"
import type { DeepLink } from "./deepLink"

export type DeepLinkRequest = DeepLink & { requestId?: number }

const target = (value: unknown): DeepLinkRequest | null => {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const bot = typeof record.bot === "string" ? record.bot : null
  const thread = typeof record.thread === "string" ? record.thread : null
  const notificationId = record.notificationId
  const hasNotificationId =
    typeof notificationId === "number" && Number.isSafeInteger(notificationId) && notificationId > 0
  if (!bot && !thread && !hasNotificationId) return null
  if (record.requestId === undefined) return { bot, thread, ...(hasNotificationId ? { notificationId } : {}) }
  if (!Number.isSafeInteger(record.requestId) || Number(record.requestId) < 1) return null
  return {
    bot,
    thread,
    ...(hasNotificationId ? { notificationId } : {}),
    requestId: Number(record.requestId),
  }
}

/** Register before reading the native inbox, so a newer click cannot be lost or overwritten. */
export const installNativeDeepLinks = ({
  listen,
  invoke,
  onLink,
}: {
  listen: (receive: (payload: unknown) => void) => Promise<() => void>
  invoke: TauriInvoke
  onLink: (link: DeepLinkRequest) => void
}) => {
  let active = true
  let stop: (() => void) | undefined
  let latestRequestId = 0
  const receive = (payload: unknown) => {
    if (!active) return
    const link = target(payload)
    if (!link) return
    if (link.requestId !== undefined) {
      if (link.requestId <= latestRequestId) return
      latestRequestId = link.requestId
    }
    onLink(link)
  }
  void (async () => {
    const unlisten = await listen(receive)
    if (!active) {
      unlisten()
      return
    }
    stop = unlisten
    receive(await invoke("deep_link_pending", {}))
  })().catch(() => undefined)
  return () => {
    active = false
    stop?.()
  }
}
