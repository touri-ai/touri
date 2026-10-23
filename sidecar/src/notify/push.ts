import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { canDeliverNotification, type Kernel, type Message, type NotificationRecord } from "@touri/contracts"
import { generateVAPIDKeys } from "web-push"
import type { AuthStore } from "../cli/auth/store"
import type { SecretStore } from "../cli/host/secretStore"
import { getNotificationSettings } from "./preferences"
import { createPushRoutes, createReviewNotice } from "./push-routes"
import { createPushStore, type PushDelivery, type PushDevice } from "./push-store"
import { getPushAccount, getPushSubscription, type PushKeys, sendWebPush } from "./push-transport"
import { createNotificationStore } from "./store"

export const initWebPush = async ({
  kernel,
  authStore,
  secrets,
  send = sendWebPush,
  now = Date.now,
  schedule = true,
}: {
  kernel: Kernel
  authStore: Pick<AuthStore, "getPersonForDevice">
  secrets: SecretStore
  send?: typeof sendWebPush
  now?: () => number
  schedule?: boolean
}) => {
  const saved = await secrets.getAsync("notify.push.keys")
  const keys: PushKeys = saved ? JSON.parse(saved) : generateVAPIDKeys()
  if (!saved) await secrets.set({ account: "notify.push.keys", value: JSON.stringify(keys) })
  const database = kernel.db as Database
  const store = createPushStore(database, now)
  const notifications = createNotificationStore({ db: database })
  const controller = new AbortController()
  const canReadNotification = (deviceId: string, notification: NotificationRecord): boolean => {
    const person = authStore.getPersonForDevice(deviceId)
    if (!person) return false
    if (notification.targetPersonId && notification.targetPersonId !== person.id) return false
    if (person.role === "admin") return true

    return Boolean(
      kernel.services.use("work.canAccessNotification")?.({
        personId: person.id,
        role: person.role,
        threadId: notification.threadId,
        kind: notification.kind,
        requestId: notification.requestId,
        targetPersonId: notification.targetPersonId ?? null,
      }),
    )
  }
  const canDeliver = (notification: NotificationRecord): boolean => {
    const bot = notification.botId ? kernel.services.use("store.api")?.getBot({ botId: notification.botId }) : null

    return canDeliverNotification({
      notification,
      botPreference: bot?.notifications ?? null,
      ...getNotificationSettings(database),
    })
  }
  const sendToDevice = async (
    device: PushDevice,
    notification?: NotificationRecord,
    requestSignal?: AbortSignal,
  ): Promise<number> => {
    if (!authStore.getPersonForDevice(device.device_id)) return 410
    const saved = await secrets.getAsync(getPushAccount(device.device_id))
    const subscription = saved ? getPushSubscription(JSON.parse(saved)) : null
    if (!subscription) return 410
    if (!authStore.getPersonForDevice(device.device_id)) return 410
    if (notification && (!canReadNotification(device.device_id, notification) || !canDeliver(notification))) return 204

    return send({
      subscription,
      keys,
      payload: JSON.stringify(getPushPayload(device.locale, notification)),
      signal: requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal,
    })
  }
  const deliver = async (delivery: PushDelivery): Promise<void> => {
    const notification = notifications.get(delivery.notification_id)
    const device = store.getDevice(delivery.device_id)
    if (
      !notification ||
      !device ||
      delivery.expires_at <= now() ||
      !canReadNotification(device.device_id, notification) ||
      !canDeliver(notification) ||
      notification.resolvedAt !== null
    ) {
      store.finish(delivery)
      return
    }
    try {
      const status = await sendToDevice(device, notification)
      if (status === 404 || status === 410) {
        await secrets.delete(getPushAccount(device.device_id))
        store.deleteDevice(device.device_id)
        return
      }
      if (status >= 200 && status < 300) {
        store.finish(delivery)
        return
      }
    } catch {
      // Endpoint URLs and subscription credentials must never enter diagnostics.
    }
    if (!controller.signal.aborted) store.retry(delivery)
  }
  const drain = async (): Promise<void> => {
    store.prune()
    await Promise.all(store.getDue().map(deliver))
  }
  const enqueue = (notification: NotificationRecord): void => {
    if (!canDeliver(notification)) return
    const devices = store.getDevices().filter((device) => canReadNotification(device.device_id, notification))
    try {
      database.transaction(() => {
        devices.forEach((device) => {
          store.enqueue(notification.id, device.device_id)
        })
      })()
    } catch {
      kernel.log({ level: "error", module: "notify", msg: "Could not schedule push delivery" })
    }
  }
  const tick = async (): Promise<void> => {
    if (controller.signal.aborted) return
    running.current = drain().catch(() => undefined)
    await running.current
    if (!controller.signal.aborted) timer.current = setTimeout(() => void tick(), 1000)
  }
  // Timer and start guard are local lifecycle state; recursive scheduling prevents overlapping sends.
  const timer: { current?: ReturnType<typeof setTimeout>; started?: boolean } = {}
  const running = { current: Promise.resolve() }
  const start = (): void => {
    if (timer.started || controller.signal.aborted) return
    timer.started = true
    void tick()
  }
  kernel.services.provide("notify.push", enqueue)
  kernel.services.provide("notify.channelNotice", ({ threadId, text }) => {
    const result = createReviewNotice(kernel, threadId, {
      eventId: createHash("sha256").update(text).digest("hex"),
      text,
      kind:
        /\bREADY\b/u.test(text) && /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/u.test(text)
          ? "pr-ready"
          : "notice",
    })
    if (result.status !== 200 || !("json" in result)) return result
    const saved = result.json as { message: Message }

    return { status: 201, json: { message: saved.message, run: null } }
  })
  kernel.registerRoutes(
    createPushRoutes({
      kernel,
      store,
      secrets,
      publicKey: keys.publicKey,
      sendTest: (device, signal) => sendToDevice(device, undefined, signal),
    }),
  )
  if (schedule) start()

  return {
    start,
    drain,
    stop: async () => {
      controller.abort()
      clearTimeout(timer.current)
      await running.current
    },
  }
}

export const getPushPayload = (locale: "pt-BR" | "en", notification?: NotificationRecord) => {
  const params = new URLSearchParams()
  if (notification?.botId) params.set("bot", notification.botId)
  if (notification?.threadId) params.set("thread", notification.threadId)
  if (notification) params.set("notification", String(notification.id))
  const key = getPushBodyKey(notification)
  const english: Record<string, string> = {
    "O bot terminou. Abra a conversa para ver o resultado.":
      "The bot finished. Open the conversation to see the result.",
    "O bot precisa de você. Abra a conversa para responder.": "The bot needs you. Open the conversation to respond.",
    "A tarefa falhou. Abra a conversa para ver o que aconteceu.":
      "The task failed. Open the conversation to see what happened.",
    "Uma revisão está pronta. Abra a conversa para conferir.": "A review is ready. Open the conversation to check it.",
    "Você tem um novo aviso. Abra o touri para conferir.": "You have a new notification. Open touri to check it.",
    "Se este aviso apareceu, a entrega está funcionando.": "If you saw this notification, delivery is working.",
  }

  return {
    id: notification?.id ?? "test",
    title: "touri",
    body: locale === "en" ? english[key] : key,
    url: `/?${params.toString()}`,
  }
}

const getPushBodyKey = (notification?: NotificationRecord): string => {
  if (!notification) return "Se este aviso apareceu, a entrega está funcionando."
  if (["approval", "question", "takeover"].includes(notification.kind))
    return "O bot precisa de você. Abra a conversa para responder."
  if (["turn-failed", "routine-failed", "incident"].includes(notification.kind))
    return "A tarefa falhou. Abra a conversa para ver o que aconteceu."
  if (["done", "delegation-settled"].includes(notification.kind))
    return "O bot terminou. Abra a conversa para ver o resultado."
  if (notification.requestId?.startsWith("pr-ready:")) return "Uma revisão está pronta. Abra a conversa para conferir."

  return "Você tem um novo aviso. Abra o touri para conferir."
}
