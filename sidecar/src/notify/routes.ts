import type { Database } from "bun:sqlite"
import type { Kernel, RouteModule, RouteResponse } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"
import { createWorkState } from "../runtime/work-state"
import type { Notifier } from "./notifier"
import { createRecoverySync, getRecoveryAcknowledgementKeys } from "./recovery"
import { parseSince, type SseHub } from "./sse"
import type { NotificationStore } from "./store"

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

const fail = (status: number, errorCode: string, error: string): RouteResponse => ({
  status,
  json: { errorCode, error },
})

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const text = (value: unknown): string => (typeof value === "string" ? value : "")

type RespondBody = { requestId: string; behavior: "allow" | "deny" | "answer"; message: string }

const parseRespond = (body: unknown): RespondBody | string => {
  const input = record(body)
  const behavior = input.behavior
  if (behavior !== "allow" && behavior !== "deny" && behavior !== "answer")
    return "behavior must be allow, deny or answer"
  if (text(input.requestId).length === 0) return "requestId is required"
  if (behavior === "answer" && text(input.message).trim().length === 0) return "message is required for answer"
  return { requestId: text(input.requestId), behavior, message: text(input.message) }
}

const answerText = ({ kind, body }: { kind: string; body: RespondBody }): string | undefined => {
  if (body.message.trim().length > 0) return `User answered: ${body.message.trim()}`
  if (kind !== "question") return undefined
  return `User answered: ${body.behavior === "allow" ? "yes" : "no"}`
}

export const createNotifyRoutes = ({
  kernel,
  store,
  notifier,
  hub,
  syncRecoveryTasks = createRecoverySync(kernel, store, notifier),
}: {
  kernel: Kernel
  store: NotificationStore
  notifier: Notifier
  hub: SseHub
  syncRecoveryTasks?: ReturnType<typeof createRecoverySync>
}): RouteModule => {
  const respond = async ({
    threadId,
    body,
    signal,
  }: {
    threadId: string
    body: unknown
    signal: AbortSignal
  }): Promise<RouteResponse> => {
    const parsed = parseRespond(body)
    if (typeof parsed === "string") return fail(400, "INVALID_ARGS", parsed)
    const target = store.byRequestId(parsed.requestId)
    if (!target || target.threadId !== threadId) return fail(404, "NOT_FOUND", "Request not found for this thread")
    const person = deviceSession(signal)?.person
    if (person?.role === "member") {
      const canAccessThread = kernel.services.use("work.canAccessThread")?.({
        personId: person.id,
        role: person.role,
        threadId,
      })
      const canApprove =
        target.kind !== "approval" ||
        kernel.services.use("work.canApprove")?.({
          personId: person.id,
          approvalId: parsed.requestId,
        })
      if (!canAccessThread || !canApprove)
        return fail(403, "DENIED", "Only the responsible person can answer this request")
    }
    if (target.resolvedAt !== null) return fail(409, "ALREADY_RESOLVED", "Request was already answered")
    const answer = kernel.services.use("runtime.answerApproval")
    if (!answer) return fail(503, "RUNTIME_UNAVAILABLE", "The runtime module is not installed")
    const isAnswer = parsed.behavior === "answer" || target.kind === "question"
    const message = isAnswer ? answerText({ kind: target.kind, body: parsed }) : undefined
    const result = await answer({
      approvalId: parsed.requestId,
      decision: !isAnswer && parsed.behavior === "allow" ? "approved" : "denied",
      ...(message === undefined ? {} : { message }),
      source: "notification",
    })
    if (!result.success) {
      if (result.errorCode === "DENIED") return fail(403, result.errorCode, result.error)
      notifier.finish({ id: target.id, resolution: "expired" })
      return fail(410, "NOT_PENDING", "The request is no longer pending")
    }
    notifier.finish({ id: target.id, resolution: parsed.behavior })
    return { status: 200, json: {} }
  }

  const sendMessage = ({ botId, body }: { botId: string; body: unknown }): RouteResponse => {
    const input = record(body)
    const messageText = text(input.text).trim()
    if (!messageText) return fail(400, "INVALID_ARGS", "text is required")
    const storeApi = kernel.services.use("store.api")
    const bot = storeApi?.getBot({ botId })
    if (!bot || !storeApi?.sendMessage) return fail(404, "NOT_FOUND", "Bot not found")
    const threadId = text(input.threadId) || bot.mainThreadId || ""
    const thread = storeApi.getThread({ threadId })
    if (!thread || thread.botId !== bot.id) return fail(404, "THREAD_NOT_FOUND", "Thread not found for this bot")
    const nonce = text(input.sendId)
    // Repeated bot sends use their original parent even after the active leaf advances.
    const existing = nonce
      ? ((kernel.db as import("bun:sqlite").Database)
          .query("SELECT request_json FROM send_journal WHERE thread_id = ? AND client_nonce = ?")
          .get(threadId, nonce) as { request_json: string } | null)
      : null
    const parentId = existing
      ? (JSON.parse(existing.request_json) as { parentId: string | null }).parentId
      : thread.activeLeafId
    return storeApi.sendMessage({
      threadId,
      parentId,
      text: messageText,
      attachmentIds: [],
      ...(nonce ? { clientNonce: nonce } : {}),
    })
  }

  return {
    name: "notify",
    routes: [
      {
        method: "GET",
        path: "/recovery",
        handler: async ({ signal }) => {
          const person = deviceSession(signal)?.person
          const tasks = syncRecoveryTasks()
          if (!person || person.role === "admin") return { status: 200, json: { tasks } }
          const visible = tasks.filter((task) =>
            kernel.services.use("work.canAccessNotification")?.({
              personId: person.id,
              role: person.role,
              threadId: task.notification.threadId,
              kind: task.notification.kind,
              requestId: task.notification.requestId,
            }),
          )
          return { status: 200, json: { tasks: visible } }
        },
      },
      {
        method: "POST",
        path: "/recovery/:id/dismiss",
        handler: async ({ params, body }) => {
          const tasks = syncRecoveryTasks()
          const task = tasks.find((item) => item.id === params.id)
          if (!task) return fail(404, "NOT_FOUND", "Tarefa interrompida não encontrada.")
          const database = kernel.db as Database
          const keys = getRecoveryAcknowledgementKeys(database, task.notification.id)
          const acknowledged = record(body).acknowledgeKeys
          if (!Array.isArray(acknowledged) || keys.some((key) => !acknowledged.includes(key)))
            return fail(
              409,
              "ACKNOWLEDGEMENT_REQUIRED",
              "Revise os efeitos incertos no centro de tarefas interrompidas.",
            )

          const work = createWorkState({ database })
          const results = keys.map((key) => work.acknowledgeKey({ key }))
          if (results.some((result) => !result.success))
            return fail(500, "STORE_ERROR", "Não foi possível salvar a confirmação. Tente novamente.")
          notifier.finish({ id: task.notification.id, resolution: "dismissed" })
          return { status: 200, json: { tasks: syncRecoveryTasks() } }
        },
      },
      {
        method: "GET",
        path: "/events",
        handler: async ({ query, signal }) => ({
          status: 200,
          mime: "text/event-stream",
          stream: hub.open({ since: parseSince({ query: query.since, header: null }), signal }),
        }),
      },
      {
        method: "GET",
        path: "/notifications/pending",
        handler: async ({ signal }) => {
          const person = deviceSession(signal)?.person
          const notifications = store.pending()
          const visible =
            !person || person.role === "admin"
              ? notifications
              : notifications.filter((notification) =>
                  kernel.services.use("work.canAccessNotification")?.({
                    personId: person.id,
                    role: person.role,
                    threadId: notification.threadId,
                    kind: notification.kind,
                    requestId: notification.requestId,
                  }),
                )
          return { status: 200, json: { notifications: visible, lastSeq: store.lastSeq() } }
        },
      },
      {
        method: "GET",
        path: "/notifications",
        handler: async ({ query, signal }) => {
          const requested = Number(query.limit ?? DEFAULT_LIST_LIMIT)
          const limit = Math.min(
            MAX_LIST_LIMIT,
            Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_LIST_LIMIT,
          )
          const notifications = store.recent(limit)
          const person = deviceSession(signal)?.person
          const visible =
            !person || person.role === "admin"
              ? notifications
              : notifications.filter((notification) =>
                  kernel.services.use("work.canAccessNotification")?.({
                    personId: person.id,
                    role: person.role,
                    threadId: notification.threadId,
                    kind: notification.kind,
                    requestId: notification.requestId,
                  }),
                )
          return { status: 200, json: { notifications: visible } }
        },
      },
      {
        method: "POST",
        path: "/notifications/dismiss-all",
        handler: async () => {
          syncRecoveryTasks()
          const open = store.getUnresolvedAttention()
          const skippedIds = open
            .filter((item) => getRecoveryAcknowledgementKeys(kernel.db as Database, item.id).length > 0)
            .map((item) => item.id)
          const protectedIds = new Set(skippedIds)
          const dismissible = open.filter((item) => !protectedIds.has(item.id))
          dismissible.forEach((item) => {
            notifier.finish({ id: item.id, resolution: "dismissed" })
          })
          return { status: 200, json: { dismissed: dismissible.length, skipped: skippedIds.length, skippedIds } }
        },
      },
      {
        method: "POST",
        path: "/notifications/:id/dismiss",
        handler: async ({ params }) => {
          syncRecoveryTasks()
          const id = Number(params.id)
          const found = Number.isInteger(id) ? store.get(id) : null
          if (!found) return fail(404, "NOT_FOUND", "Notification not found")
          if (getRecoveryAcknowledgementKeys(kernel.db as Database, id).length > 0)
            return fail(
              409,
              "ACKNOWLEDGEMENT_REQUIRED",
              "Revise os efeitos incertos no centro de tarefas interrompidas.",
            )
          notifier.finish({ id, resolution: "dismissed" })
          return { status: 200, json: { notification: store.get(id) } }
        },
      },
      {
        method: "POST",
        path: "/threads/:id/respond",
        handler: async ({ params, body, signal }) => respond({ threadId: params.id ?? "", body, signal }),
      },
      {
        method: "POST",
        path: "/bots/:id/messages",
        handler: async ({ params, body }) => sendMessage({ botId: params.id ?? "", body }),
      },
    ],
  }
}
