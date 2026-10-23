import { generateRequestDetails, type PushSubscription } from "web-push"

export type PushKeys = { publicKey: string; privateKey: string }
export type PushSubscriptionInput = PushSubscription & { locale: "pt-BR" | "en" }

export const getPushAccount = (deviceId: string): string => `notify.push.device.${deviceId}`

export const getPushSubscription = (input: unknown): PushSubscriptionInput | null => {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  if (typeof record.endpoint !== "string" || record.endpoint.length > 2048) return null
  if (!isPushEndpoint(record.endpoint) || !record.keys || typeof record.keys !== "object") return null
  const keys = record.keys as Record<string, unknown>
  if (typeof keys.p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/u.test(keys.p256dh)) return null
  if (typeof keys.auth !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(keys.auth)) return null
  if (Buffer.from(keys.p256dh, "base64url")[0] !== 4) return null
  if (record.locale !== "pt-BR" && record.locale !== "en") return null

  return { endpoint: record.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, locale: record.locale }
}

export const sendWebPush = async ({
  subscription,
  keys,
  payload,
  signal,
  fetch: send = fetch,
}: {
  subscription: PushSubscription
  keys: PushKeys
  payload: string
  signal: AbortSignal
  fetch?: typeof fetch
}): Promise<number> => {
  if (!isPushEndpoint(subscription.endpoint) || Buffer.byteLength(payload) > 1500) return 400

  // Encryption/signing is bounded to one small payload; no transcript is sent to the push service.
  const request = generateRequestDetails(subscription, payload, {
    TTL: 3600,
    urgency: "normal",
    vapidDetails: { subject: "https://touri.ai", publicKey: keys.publicKey, privateKey: keys.privateKey },
  })
  const response = await send(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body ? new Uint8Array(request.body) : null,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  await response.body?.cancel()

  return response.status
}

const isPushEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false

    // Browser-owned destinations only. No user-selected hosts, proxies or redirects.
    return (
      url.hostname === "web.push.apple.com" ||
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "updates.push.services.mozilla.com" ||
      /^[a-z0-9-]+\.push\.services\.mozilla\.com$/u.test(url.hostname)
    )
  } catch {
    return false
  }
}
