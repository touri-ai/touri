import { createHash } from "node:crypto"
import type { Kernel, RouteModule, RouteResponse } from "@touri/contracts"
import type { SecretStore } from "../cli/host/secretStore"
import { deviceSession } from "../kernel/device-session"
import type { PushDevice, PushStore } from "./push-store"
import { getPushAccount, getPushSubscription } from "./push-transport"

export const createPushRoutes = ({
  kernel,
  store,
  secrets,
  publicKey,
  sendTest,
}: {
  kernel: Kernel
  store: PushStore
  secrets: SecretStore
  publicKey: string
  sendTest: (device: PushDevice, signal: AbortSignal) => Promise<number>
}): RouteModule => ({
  name: "web-push",
  routes: [
    {
      method: "GET",
      path: "/push",
      handler: async ({ signal }) => {
        const session = deviceSession(signal)
        if (!session?.active()) return denied()

        return { status: 200, json: { publicKey, subscribed: Boolean(store.getDevice(session.deviceId)) } }
      },
    },
    {
      method: "PUT",
      path: "/push",
      handler: async ({ signal, body }) => {
        const session = deviceSession(signal)
        if (!session?.active() || !session.origin?.startsWith("https://")) return denied()
        const subscription = getPushSubscription(body)
        if (!subscription)
          return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Invalid push subscription" } }
        if (!store.getDevice(session.deviceId) && store.getDevices().length >= 32)
          return { status: 409, json: { errorCode: "LIMIT_REACHED", error: "Too many push devices" } }

        await secrets.set({ account: getPushAccount(session.deviceId), value: JSON.stringify(subscription) })
        if (!session.active()) {
          await secrets.delete(getPushAccount(session.deviceId))
          return denied()
        }
        store.saveDevice(session.deviceId, subscription.locale)

        return { status: 200, json: {} }
      },
    },
    {
      method: "DELETE",
      path: "/push",
      handler: async ({ signal }) => {
        const session = deviceSession(signal)
        if (!session?.active()) return denied()
        store.deleteDevice(session.deviceId)
        await secrets.delete(getPushAccount(session.deviceId))

        return { status: 200, json: {} }
      },
    },
    {
      method: "POST",
      path: "/push/test",
      handler: async ({ signal }) => {
        const session = deviceSession(signal)
        if (!session?.active()) return denied()
        const device = store.getDevice(session.deviceId)
        if (!device) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Push is not enabled" } }
        const status = await sendTest(device, signal).catch(() => 503)
        if (status < 200 || status >= 300)
          return { status: 503, json: { errorCode: "DELIVERY_FAILED", error: "Push test failed" } }

        return { status: 200, json: {} }
      },
    },
    {
      method: "POST",
      path: "/threads/:id/notices",
      handler: async ({ signal, params, body }) => {
        const session = deviceSession(signal)
        if (!session?.active() || session.person?.role !== "admin") return denied()

        return createReviewNotice(kernel, params.id ?? "", body)
      },
    },
  ],
})

const denied = (): RouteResponse => ({
  status: 403,
  json: { errorCode: "DENIED", error: "Device authorization required" },
})

export const createReviewNotice = (kernel: Kernel, threadId: string, body: unknown): RouteResponse => {
  if (!body || typeof body !== "object") return invalidNotice()
  const input = body as Record<string, unknown>
  if (
    !["pr-ready", "notice"].includes(String(input.kind)) ||
    typeof input.eventId !== "string" ||
    !/^[\w:./-]{1,160}$/u.test(input.eventId)
  )
    return invalidNotice()
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) return invalidNotice()
  const store = kernel.services.use("store.api")
  const emit = kernel.services.use("notify.emit")
  const thread = store?.getThread({ threadId })
  if (!store || !emit || !thread?.groupId || thread.groupThreadId)
    return { status: 404, json: { errorCode: "NOT_FOUND", error: "Channel conversation not found" } }

  const eventId = createHash("sha256").update(`${threadId}:${input.eventId}`).digest("hex")
  const messageId = `${input.kind}:${eventId}`
  const text = kernel.redact(input.text.trim())
  const existing = store.getPathMessage?.({ threadId, messageId, leafId: messageId })
  const inserted = existing
    ? { success: true as const, message: existing }
    : store.insertMessage({
        message: {
          id: messageId,
          threadId,
          parentId: thread.activeLeafId,
          role: "assistant",
          kind: "notice",
          status: "complete",
          runId: null,
          text,
          parts: [{ type: "notice", level: "info", code: "automation_notice", text }],
          sender: { id: "automation-notices", name: "touri" },
          source: "local",
        },
      })
  if (!inserted.success) return { status: 409, json: { errorCode: inserted.errorCode, error: "Could not save notice" } }
  const notification = emit({
    kind: "notice",
    botId: null,
    threadId,
    requestId: messageId,
    targetPersonId: kernel.services.use("work.defaultPersonId")?.() ?? "owner",
    title: input.kind === "pr-ready" ? "PR ready" : "Automatic notice",
    body: text,
  })

  return { status: 200, json: { notification, message: inserted.message } }
}

const invalidNotice = (): RouteResponse => ({
  status: 400,
  json: { errorCode: "INVALID_ARGS", error: "Invalid review notice" },
})
