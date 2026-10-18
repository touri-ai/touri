import type { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import type {
  Id,
  Kernel,
  NotificationRecord,
  Routine,
  RoutineRun,
  Run,
  TelegramIntegrationStatus,
  Thread,
  UiEvent,
} from "@touri/contracts"
import {
  createTelegramApi,
  type TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from "./api"
import type { TelegramStore } from "./store"
import { splitMessage } from "./text"

const ACTIVE: ReadonlyArray<Run["status"]> = ["queued", "starting", "running"]
const TYPING_EVERY_MS = 4_000
const TYPING_MAX_MS = 15 * 60_000
const ROUTINE_FRESH_MS = 10 * 60_000
const MAX_PENDING_PROMPTS = 200
const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000]

type Prompt = {
  requestId: string
  kind: "approval" | "question"
  chatId: string
  messageId: number
  text: string
  settled: boolean
}

const displayName = (user: TelegramUser | undefined): string =>
  [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
  (user?.username ? `@${user.username}` : String(user?.id ?? ""))

/** One long-polling connection between a bot and its Telegram account. */
export const createTelegramBridge = ({
  kernel,
  botId,
  token,
  store,
  apiBase,
  pollTimeoutSec = 25,
  typingIntervalMs = TYPING_EVERY_MS,
  onStatus,
}: {
  kernel: Kernel
  botId: Id
  token: string
  store: TelegramStore
  apiBase?: string
  pollTimeoutSec?: number
  typingIntervalMs?: number
  onStatus: (status: TelegramIntegrationStatus) => void
}) => {
  const controller = new AbortController()
  const api: TelegramApi = createTelegramApi({
    token,
    signal: controller.signal,
    ...(apiBase ? { base: apiBase } : {}),
  })
  const accountId = createHash("sha256").update(token).digest("hex").slice(0, 16)
  store.setAccount(botId, accountId)
  const typing = new Map<string, { timer: ReturnType<typeof setInterval>; started: number }>()
  const forwarded = new Set<Id>()
  const routinesSent = new Set<Id>(store.state(botId).routineRunIds)
  const prompts = new Map<string, Prompt>()
  let stopped = false
  let loop: Promise<void> = Promise.resolve()

  const log = (msg: string, data?: Record<string, unknown>) =>
    kernel.log({ level: "warn", module: "telegram", msg, ...(data ? { data } : {}) })
  const errorText = (error: unknown): string =>
    kernel.redact(error instanceof TelegramApiError ? error.description : String(error))

  const storeApi = () => kernel.services.use("store.api")
  const config = () => store.config(botId)
  const allowed = (userId: number | undefined): boolean =>
    userId !== undefined && config().allowedUserIds.includes(String(userId))
  const chatAllowed = (chatId: string): boolean => !stopped && config().allowedUserIds.includes(chatId)
  const chatForThread = (threadId: Id): string | null => {
    for (const [chatId, linked] of Object.entries(store.state(botId).chats))
      if (linked === threadId && chatAllowed(chatId)) return chatId
    return null
  }

  const send = async (chatId: string, text: string, routine = false): Promise<boolean> => {
    for (const chunk of splitMessage(text)) {
      const current = config()
      if (stopped || (routine ? !current.forwardRoutines || current.homeChatId !== chatId : !chatAllowed(chatId)))
        return false
      await api.sendMessage({ chat_id: chatId, text: chunk })
    }
    return true
  }
  const safeSend = (chatId: string, text: string, routine = false): Promise<void> =>
    send(chatId, text, routine)
      .then(() => undefined)
      .catch((error) => {
        if (!stopped) log("Falha ao enviar mensagem ao Telegram", { error: errorText(error) })
      })

  const stopTyping = (chatId: string) => {
    const entry = typing.get(chatId)
    if (entry) clearInterval(entry.timer)
    typing.delete(chatId)
  }
  const startTyping = (chatId: string) => {
    if (typing.has(chatId) || stopped) return
    const tick = () => {
      const entry = typing.get(chatId)
      if (!chatAllowed(chatId) || (entry && Date.now() - entry.started > TYPING_MAX_MS)) {
        stopTyping(chatId)
        return
      }
      void api.sendChatAction({ chat_id: chatId, action: "typing" }).catch(() => undefined)
    }
    typing.set(chatId, { timer: setInterval(tick, typingIntervalMs), started: Date.now() })
    tick()
  }

  const linkedThread = (chatId: string): Thread | null => {
    const threadId = store.state(botId).chats[chatId]
    const thread = threadId ? storeApi()?.getThread({ threadId }) : null
    return thread && thread.botId === botId && !thread.archivedAt ? thread : null
  }
  const newThread = (message: TelegramMessage): Thread | null => {
    const created = storeApi()?.createThread({
      botId,
      kind: "chat",
      title: `Telegram · ${displayName(message.from)}`.slice(0, 80),
    })
    if (!created?.success) return null
    const state = store.state(botId)
    store.saveState(botId, { ...state, chats: { ...state.chats, [String(message.chat.id)]: created.thread.id } })
    return created.thread
  }

  const command = async (message: TelegramMessage, name: string): Promise<boolean> => {
    const chatId = String(message.chat.id)
    const bot = storeApi()?.getBot({ botId })
    if (name === "/start") {
      await send(chatId, `Conectado a ${bot?.name ?? "touri"}. Mande uma mensagem para começar.`)
      return true
    }
    if (name === "/new") {
      const thread = newThread(message)
      if (thread) stopTyping(chatId)
      await send(chatId, thread ? `Nova conversa: ${thread.title}` : "Não consegui criar uma conversa.")
      return true
    }
    if (name === "/stop" || name === "/status") {
      const thread = linkedThread(chatId)
      const active = thread ? kernel.services.use("runtime.activeRun")?.({ threadId: thread.id }) : null
      if (name === "/status") {
        await send(
          chatId,
          thread
            ? `Conversa: ${thread.title}. ${active ? "Respondendo agora." : "Nada em andamento."}`
            : "Nenhuma conversa ainda. Mande uma mensagem para começar.",
        )
        return true
      }
      const canceled = active ? (kernel.services.use("runtime.cancelRun")?.({ runId: active.id }) ?? false) : false
      if (canceled) stopTyping(chatId)
      await send(chatId, canceled ? "Parei a resposta em andamento." : "Nada em andamento.")
      return true
    }
    return false
  }

  const onMessage = async (update: TelegramUpdate, message: TelegramMessage): Promise<void> => {
    if (message.chat.type !== "private" || message.from?.is_bot) return
    if (!allowed(message.from?.id)) {
      const state = store.state(botId)
      store.saveState(botId, {
        ...state,
        lastRejected: { userId: String(message.from?.id ?? ""), name: displayName(message.from), at: Date.now() },
      })
      return
    }
    const chatId = String(message.chat.id)
    const text = message.text?.trim() ?? ""
    if (!text) {
      await send(chatId, "Por enquanto só leio mensagens de texto.")
      return
    }
    if (text.startsWith("/") && (await command(message, text.split(/\s/)[0]?.split("@")[0] ?? ""))) return
    const thread = linkedThread(chatId) ?? newThread(message)
    const api = storeApi()
    if (!thread || !api?.sendMessage) {
      await send(chatId, "Não consegui entregar a mensagem ao bot.")
      return
    }
    const clientNonce = `tg-${botId}-${accountId}-${update.update_id}`
    const previous = (kernel.db as Database)
      .query("SELECT request_json FROM send_journal WHERE thread_id = ? AND client_nonce = ?")
      .get(thread.id, clientNonce) as { request_json: string } | null
    const parentId = previous
      ? (JSON.parse(previous.request_json) as { parentId: Id | null }).parentId
      : thread.activeLeafId
    const response = api.sendMessage({
      threadId: thread.id,
      parentId,
      text,
      attachmentIds: [],
      clientNonce,
    })
    if (response.status >= 400) await send(chatId, "Não consegui entregar a mensagem ao bot.")
  }

  const onCallback = async (query: TelegramCallbackQuery): Promise<void> => {
    const [prefix, id, choice] = query.data?.split(":") ?? []
    const prompt = id ? prompts.get(id) : undefined
    if (!allowed(query.from.id)) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: "Sem permissão." })
      return
    }
    if (
      prefix !== "tg" ||
      (choice !== "y" && choice !== "n") ||
      !prompt ||
      prompt.settled ||
      !query.message ||
      query.message.chat.type !== "private" ||
      String(query.message.chat.id) !== prompt.chatId ||
      query.message.message_id !== prompt.messageId ||
      !chatAllowed(prompt.chatId)
    ) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: "Pedido expirado." })
      return
    }
    prompt.settled = true
    const allow = choice === "y"
    const question = prompt.kind === "question"
    const answer = kernel.services.use("runtime.answerApproval")
    const result = answer
      ? await answer({
          approvalId: prompt.requestId,
          decision: !question && allow ? "approved" : "denied",
          ...(question ? { message: `User answered: ${allow ? "yes" : "no"}` } : {}),
        })
      : { success: false as const }
    kernel.services.use("notify.resolve")?.({
      requestId: prompt.requestId,
      resolution: result.success ? (question ? "answer" : allow ? "allow" : "deny") : "expired",
    })
    const outcome = !result.success
      ? "Pedido expirado."
      : question
        ? `Resposta: ${allow ? "sim" : "não"}.`
        : allow
          ? `Aprovado por ${displayName(query.from)}.`
          : `Negado por ${displayName(query.from)}.`
    await api.answerCallbackQuery({ callback_query_id: query.id, text: outcome })
    await api
      .editMessageText({ chat_id: prompt.chatId, message_id: prompt.messageId, text: `${prompt.text}\n\n${outcome}` })
      .catch(() => undefined)
  }

  const onRun = (run: Run): void => {
    if (run.botId !== botId) return
    const chatId = chatForThread(run.threadId)
    if (!chatId) return
    if (ACTIVE.includes(run.status)) {
      startTyping(chatId)
      return
    }
    stopTyping(chatId)
    if (run.status === "interrupted" || forwarded.has(run.id)) return
    forwarded.add(run.id)
    if (run.status === "canceled") {
      void safeSend(chatId, "Resposta cancelada.")
      return
    }
    if (run.status === "failed") {
      void safeSend(chatId, "Não consegui concluir esta resposta. Veja os detalhes no touri.")
      return
    }
    const path = storeApi()?.activePath({ threadId: run.threadId }) ?? []
    const reply =
      path.find((message) => message.id === run.replyMessageId) ??
      [...path].reverse().find((message) => message.role === "assistant")
    if (reply?.text.trim()) void safeSend(chatId, reply.text)
  }

  const onNotification = async (notification: NotificationRecord): Promise<void> => {
    if (notification.botId !== botId || !notification.requestId || !notification.threadId) return
    if (notification.kind !== "approval" && notification.kind !== "question") return
    const chatId = chatForThread(notification.threadId)
    if (!chatId) return
    const fullText = [notification.title, notification.body].filter(Boolean).join("\n")
    if (fullText.length > 3_500) {
      await safeSend(chatId, "Este pedido é longo. Abra o touri para conferir e responder.")
      return
    }
    const id = randomBytes(16).toString("hex")
    const text = fullText
    const prompt: Prompt = {
      requestId: notification.requestId,
      kind: notification.kind,
      chatId,
      messageId: 0,
      text,
      settled: false,
    }
    prompts.set(id, prompt)
    const labels = notification.kind === "approval" ? ["Aprovar", "Negar"] : ["Sim", "Não"]
    try {
      const sent = await api.sendMessage({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: labels[0] ?? "", callback_data: `tg:${id}:y` },
              { text: labels[1] ?? "", callback_data: `tg:${id}:n` },
            ],
          ],
        },
      })
      prompt.messageId = sent.message_id
      if (prompt.settled && !stopped) {
        await api
          .editMessageText({ chat_id: chatId, message_id: prompt.messageId, text: `${text}\n\nRespondido no touri.` })
          .catch(() => undefined)
      }
      for (const key of prompts.keys()) {
        if (prompts.size <= MAX_PENDING_PROMPTS) break
        prompts.delete(key)
      }
    } catch (error) {
      prompts.delete(id)
      if (!stopped) log("Falha ao enviar aprovação ao Telegram", { error: errorText(error) })
    }
  }

  const onResolved = (notification: NotificationRecord): void => {
    for (const prompt of prompts.values()) {
      if (prompt.requestId !== notification.requestId || prompt.settled) continue
      prompt.settled = true
      if (!prompt.messageId || !chatAllowed(prompt.chatId)) continue
      void api
        .editMessageText({
          chat_id: prompt.chatId,
          message_id: prompt.messageId,
          text: `${prompt.text}\n\nRespondido no touri.`,
        })
        .catch(() => undefined)
    }
  }

  const onRoutine = (routine: Routine, run: RoutineRun | null): void => {
    const { forwardRoutines, homeChatId } = config()
    if (routine.botId !== botId || !forwardRoutines || !homeChatId || !run) return
    if (run.status !== "succeeded" && run.status !== "failed") return
    if (routinesSent.has(run.id) || Date.now() - (run.finishedAt ?? 0) > ROUTINE_FRESH_MS) return
    routinesSent.add(run.id)
    const path = run.threadId ? (storeApi()?.activePath({ threadId: run.threadId }) ?? []) : []
    const reply = [...path].reverse().find((message) => message.role === "assistant" && message.text.trim())
    const body = run.status === "succeeded" ? (reply?.text ?? run.summary ?? "") : `falhou. ${run.summary ?? ""}`
    void send(homeChatId, `${routine.name}: ${body}`.trim(), true)
      .then((sent) => {
        if (!sent || stopped) {
          routinesSent.delete(run.id)
          return
        }
        const state = store.state(botId)
        store.saveState(botId, { ...state, routineRunIds: [...state.routineRunIds, run.id].slice(-200) })
      })
      .catch((error) => {
        routinesSent.delete(run.id)
        if (!stopped) log("Falha ao enviar resultado de rotina ao Telegram", { error: errorText(error) })
      })
  }

  const onEvent = (event: UiEvent): void => {
    if (stopped) return
    if (event.type === "run.updated") onRun(event.run)
    else if (event.type === "notification.created") void onNotification(event.notification)
    else if (event.type === "notification.resolved") onResolved(event.notification)
    else if (event.type === "routine.updated") onRoutine(event.routine, event.lastRun)
  }

  const poll = async (): Promise<void> => {
    let failures = 0
    let handshake = true
    while (!stopped) {
      try {
        if (handshake) {
          onStatus({ state: "connecting", username: null, error: null })
          const me = await api.getMe(controller.signal)
          onStatus({ state: "connected", username: me.username ?? null, error: null })
          handshake = false
        }
        const updates = await api.getUpdates(
          { offset: store.state(botId).offset, timeout: pollTimeoutSec },
          controller.signal,
        )
        failures = 0
        for (const update of updates) {
          if (stopped) return
          if (update.update_id < store.state(botId).offset) continue
          if (update.message) await onMessage(update, update.message)
          else if (update.callback_query) await onCallback(update.callback_query)
          if (stopped) return
          store.saveState(botId, { ...store.state(botId), offset: update.update_id + 1 })
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) return
        const unauthorized = error instanceof TelegramApiError && error.unauthorized
        onStatus({
          state: "error",
          username: null,
          error: unauthorized
            ? "Token inválido ou revogado."
            : "Não foi possível conectar ao Telegram. Confira sua conexão e tente novamente.",
        })
        if (unauthorized) return
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 60_000
        failures += 1
        handshake = true
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, wait)
          controller.signal.addEventListener("abort", done, { once: true })
        })
      }
    }
  }

  const unsubscribe = kernel.subscribe(({ event }) => onEvent(event))

  return {
    start: () => {
      loop = poll()
    },
    stop: async (): Promise<void> => {
      stopped = true
      controller.abort()
      unsubscribe()
      for (const chatId of [...typing.keys()]) stopTyping(chatId)
      await loop.catch(() => undefined)
    },
  }
}

export type TelegramBridge = ReturnType<typeof createTelegramBridge>
