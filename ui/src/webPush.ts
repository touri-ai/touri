import { DEFAULT_LOCALE } from "./i18n"

export type WebPushStatus = { supported: boolean; subscribed: boolean }
export type WebPushClient = {
  getStatus: () => Promise<WebPushStatus>
  enable: () => Promise<void>
  disable: () => Promise<void>
  test: () => Promise<void>
}

export const createWebPushClient = (): WebPushClient => {
  const supported =
    window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  const registerWorker = async () => {
    if (!supported) throw new Error("PUSH_UNSUPPORTED")
    await navigator.serviceWorker.register("/push-worker.js", { scope: "/" })

    return navigator.serviceWorker.ready
  }
  const getConfig = () => request<{ publicKey: string; subscribed: boolean }>("", "GET")

  return {
    getStatus: async () => {
      if (!supported) return { supported: false, subscribed: false }
      const [config, worker] = await Promise.all([getConfig(), registerWorker()])
      const subscription = await worker.pushManager.getSubscription()

      return {
        supported: true,
        subscribed: config.subscribed && Boolean(subscription) && Notification.permission === "granted",
      }
    },
    enable: async () => {
      // Permission must start in the user's click, before any network or registration await.
      if (!supported) throw new Error("PUSH_UNSUPPORTED")
      const permission = await Notification.requestPermission()
      if (permission !== "granted") throw new Error("PUSH_DENIED")
      const [config, worker] = await Promise.all([getConfig(), registerWorker()])
      const current = await worker.pushManager.getSubscription()
      const subscription =
        current ??
        (await worker.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: getApplicationKey(config.publicKey),
        }))
      try {
        await request("", "PUT", {
          ...subscription.toJSON(),
          locale: document.documentElement.lang === "en" ? "en" : DEFAULT_LOCALE,
        })
      } catch (error) {
        if (!current) await subscription.unsubscribe()
        throw error
      }
    },
    disable: async () => {
      await request("", "DELETE")
      const worker = await registerWorker()
      await (await worker.pushManager.getSubscription())?.unsubscribe()
    },
    test: async () => {
      await request("/test", "POST")
    },
  }
}

const request = async <T = object>(path: string, method: string, body?: object): Promise<T> => {
  const response = await fetch(`/api/v1/push${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error("PUSH_FAILED")

  return response.json() as Promise<T>
}

const getApplicationKey = (value: string): Uint8Array<ArrayBuffer> => {
  const decoded = atob(value.replace(/-/gu, "+").replace(/_/gu, "/"))

  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}
