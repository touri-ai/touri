import type { Message, Run, SendMessageInput, UiEvent } from "@touri/contracts"
import { ApiError } from "../errors"
import { scopedStorageKey } from "../storageScope"
import type { ApiRequest } from "./client"

type PendingSend = { input: SendMessageInput & { clientNonce: string; deadline: number }; message: Message }
const STORAGE_KEY = "touri.send-journal.v1"

export const createSendJournal = ({
  request,
  emit,
  storage,
  scope,
  now = Date.now,
}: {
  request: ApiRequest
  emit: (event: UiEvent) => void
  storage: Pick<Storage, "getItem" | "setItem">
  /** A stable server origin keeps pending sends bound to their original machine. */
  scope?: string | null
  now?: () => number
}) => {
  const storageKey = scopedStorageKey(STORAGE_KEY, scope ?? null)
  const read = (): PendingSend[] => {
    const saved = storage.getItem(storageKey)
    if (!saved) return []
    const parsed = JSON.parse(saved) as unknown
    if (!Array.isArray(parsed)) throw new Error("A fila de mensagens salva está inválida.")
    return parsed as PendingSend[]
  }
  let entries = read()
  let connected = true
  let draining = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 500
  const save = (): void => storage.setItem(storageKey, JSON.stringify(entries))
  const status = (entry: PendingSend, next: NonNullable<Message["delivery"]>["status"]): void => {
    if (!entries.includes(entry)) return
    entry.message = {
      ...entry.message,
      delivery: { clientNonce: entry.input.clientNonce, deadline: entry.input.deadline, status: next },
    }
    save()
    emit({ type: "message.updated", message: entry.message })
  }
  const expire = (): void => {
    for (const entry of entries) {
      // An uncertain send must first query the server with the same nonce: it may have been acked.
      if (entry.message.delivery?.status === "queued" && entry.input.deadline <= now()) status(entry, "failed")
    }
    armExpiry()
  }
  const armExpiry = (): void => {
    clearTimeout(timer)
    const deadlines = entries
      .filter((entry) => entry.message.delivery?.status === "queued")
      .map((entry) => entry.input.deadline)
    if (deadlines.length)
      timer = setTimeout(expire, Math.max(1, Math.min(2_147_483_647, Math.min(...deadlines) - now())))
  }
  const scheduleRetry = (): void => {
    if (!connected || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void drain()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 5000)
  }
  const drain = async (): Promise<void> => {
    if (draining || !connected) return
    draining = true
    try {
      while (connected) {
        const entry = entries.find((candidate) => candidate.message.delivery?.status !== "failed")
        if (!entry) break
        if (entry.message.delivery?.status === "queued" && entry.input.deadline <= now()) {
          status(entry, "failed")
          continue
        }
        status(entry, "sent")
        try {
          const response = await request("POST /threads/:id/messages", entry.input, { id: entry.input.threadId })
          entries = entries.filter(
            (candidate) =>
              candidate.input.clientNonce !== entry.input.clientNonce ||
              candidate.input.threadId !== entry.input.threadId,
          )
          save()
          emit({ type: "message.updated", message: response.message })
          if (response.run) emit({ type: "run.updated", run: response.run })
          retryDelay = 500
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) status(entry, "failed")
          // Keep sent when acknowledgement was lost. Reconnect retries this exact nonce and deadline.
          else if (entries.includes(entry)) {
            scheduleRetry()
            break
          }
        }
      }
    } finally {
      draining = false
      armExpiry()
    }
  }
  const enqueue = async (input: SendMessageInput): Promise<{ message: Message; run: Run | null }> => {
    const clientNonce = input.clientNonce ?? crypto.randomUUID()
    const previous = entries.find(
      (entry) => entry.input.clientNonce === clientNonce && entry.input.threadId === input.threadId,
    )
    if (previous) {
      if (
        previous.input.text !== input.text ||
        previous.input.groupAction !== input.groupAction ||
        previous.input.parentId !== input.parentId ||
        JSON.stringify(previous.input.attachmentIds) !== JSON.stringify(input.attachmentIds) ||
        (input.deadline !== undefined && input.deadline !== previous.input.deadline)
      )
        throw new ApiError(409, "Este envio já contém outra mensagem.", "NONCE_CONFLICT")
      return { message: previous.message, run: null }
    }
    const deadline = input.deadline ?? now() + 24 * 60 * 60_000
    const message: Message = {
      id: `send:${clientNonce}`,
      threadId: input.threadId,
      parentId: input.parentId,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: input.text,
      parts: [{ type: "text", text: input.text }],
      sender: null,
      source: "local",
      createdAt: now(),
      updatedAt: now(),
      delivery: { clientNonce, deadline, status: "queued" },
    }
    entries.push({ input: { ...input, clientNonce, deadline }, message })
    try {
      save()
    } catch (error) {
      entries.pop()
      throw error
    }
    emit({ type: "message.created", message })
    armExpiry()
    queueMicrotask(() => void drain())
    return { message, run: null }
  }
  armExpiry()
  return {
    enqueue,
    watchDeadlines: armExpiry,
    messages: (): Message[] => entries.map((entry) => structuredClone(entry.message)),
    acknowledge: (message: Message): void => {
      if (message.delivery?.status === "failed") {
        const entry = entries.find(
          (entry) =>
            entry.input.threadId === message.threadId && entry.input.clientNonce === message.delivery?.clientNonce,
        )
        if (entry) {
          entry.message = structuredClone(message)
          save()
        }
        return
      }
      if (message.delivery?.status !== "acked") return
      entries = entries.filter(
        (entry) =>
          entry.input.threadId !== message.threadId || entry.input.clientNonce !== message.delivery?.clientNonce,
      )
      save()
      armExpiry()
    },
    reconnect: (): void => {
      connected = true
      clearTimeout(retryTimer)
      retryTimer = undefined
      armExpiry()
      void drain()
    },
    disconnect: (): void => {
      connected = false
      clearTimeout(retryTimer)
      retryTimer = undefined
    },
    stop: (): void => {
      connected = false
      clearTimeout(timer)
      clearTimeout(retryTimer)
      retryTimer = undefined
    },
  }
}
