import type { Database } from "bun:sqlite"
import type { Kernel, Message, MessagePart, RouteResponse, SendMessageInput, StoreApi } from "@touri/contracts"
import { errorResponse, TouriError } from "../kernel/errors"
import { toRun } from "../runtime/persistence"

type Entry = {
  thread_id: string
  client_nonce: string
  request_json: string
  message_id: string
  deadline: number
  status: "queued" | "sent" | "acked" | "failed"
  run_id: string | null
  error_code: string | null
}

export const createSendJournal = ({
  kernel,
  database,
  store,
  getMessage,
}: {
  kernel: Kernel
  database: Database
  store: StoreApi
  getMessage: (args: { threadId: string; messageId: string }) => Message | null
}) => {
  const find = (threadId: string, nonce: string): Entry | null =>
    database
      .query("SELECT * FROM send_journal WHERE thread_id = ? AND client_nonce = ?")
      .get(threadId, nonce) as Entry | null

  const setStatus = (
    entry: Entry,
    status: Entry["status"],
    runId: string | null = null,
    errorCode: string | null = null,
  ): void => {
    const at = Date.now()
    database
      .query(
        "UPDATE send_journal SET status = ?, run_id = ?, error_code = ?, updated_at = ? WHERE thread_id = ? AND client_nonce = ?",
      )
      .run(status, runId, errorCode, at, entry.thread_id, entry.client_nonce)
    database
      .query("UPDATE messages SET delivery_status = ?, run_id = ?, updated_at = ? WHERE thread_id = ? AND id = ?")
      .run(status, runId, at, entry.thread_id, entry.message_id)
    const message = getMessage({ threadId: entry.thread_id, messageId: entry.message_id })
    if (message) kernel.publish({ type: "message.updated", message })
  }

  const dispatch = (entry: Entry): void => {
    if (entry.status === "acked" || entry.status === "failed") return
    if (kernel.services.use("runtime.isDraining")?.()) return
    const enqueue = kernel.services.use("runtime.enqueue")
    if (entry.deadline <= Date.now()) {
      database.transaction(() => setStatus(entry, "failed", null, "DEADLINE_EXCEEDED"))()
      return
    }
    if (!enqueue) return
    try {
      database.transaction(() => {
        setStatus(entry, "sent")
        const queued = enqueue({ threadId: entry.thread_id, requestMessageId: entry.message_id, trigger: "user" })
        if (!queued.success) {
          setStatus(entry, "failed", null, queued.errorCode)
          return
        }
        // An acknowledgement requires a run persisted by enqueue in this same transaction.
        const persisted = database
          .query("SELECT id FROM runs WHERE id = ? AND thread_id = ?")
          .get(queued.run.id, entry.thread_id)
        if (!persisted) throw new TouriError("TOURI-E1010")
        setStatus(entry, "acked", queued.run.id)
      })()
    } catch {
      // Roll back any partial run, then make this nonce terminal so retries cannot enqueue twice.
      database.transaction(() => setStatus(entry, "failed", null, "TOURI-E1010"))()
    }
  }

  const reply = (entry: Entry): RouteResponse => {
    const message = getMessage({ threadId: entry.thread_id, messageId: entry.message_id })
    const rawRun = entry.run_id ? database.query("SELECT * FROM runs WHERE id = ?").get(entry.run_id) : null
    const run = toRun(rawRun)
    if (run) return { status: 200, json: { message, run } }
    const code = entry.error_code ?? "RUNTIME_UNAVAILABLE"
    return {
      status: entry.status === "failed" ? 409 : 503,
      json: {
        errorCode: code,
        error:
          entry.status === "failed"
            ? "Não foi possível entregar a mensagem."
            : "Mensagem na fila; aguardando o serviço.",
        message,
      },
    }
  }

  const send = (input: SendMessageInput): RouteResponse => {
    const nonce = input.clientNonce ?? kernel.newId()
    const deadline = input.deadline ?? Date.now() + 24 * 60 * 60_000
    if (typeof nonce !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(nonce) || !Number.isSafeInteger(deadline))
      return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Identificador ou prazo de envio inválido." } }
    if (input.groupAction) {
      const thread = store.getThread({ threadId: input.threadId })
      if (!["ask_all", "summarize"].includes(input.groupAction) || !thread?.groupId || thread.groupThreadId)
        return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Esta ação exige uma conversa de grupo." } }
    }
    const requestJson = JSON.stringify({
      ...(input.groupAction ? { groupAction: input.groupAction } : {}),
      parentId: input.parentId,
      text: input.text,
      attachmentIds: input.attachmentIds,
    })
    const previous = find(input.threadId, nonce)
    if (previous) {
      if (previous.request_json !== requestJson || (previous.deadline !== deadline && input.deadline !== undefined))
        return { status: 409, json: { errorCode: "NONCE_CONFLICT", error: "Este envio já contém outra mensagem." } }
      dispatch(previous)
      return reply(find(input.threadId, nonce) ?? previous)
    }
    const parts: Array<MessagePart> = [
      { type: "text", text: input.text },
      ...(input.groupAction
        ? [
            {
              type: "notice" as const,
              level: "info" as const,
              code: input.groupAction === "ask_all" ? ("group_ask_all" as const) : ("group_summary" as const),
              text: input.groupAction === "ask_all" ? "Perguntar a todos" : "Pedir resumo do time",
            },
          ]
        : []),
    ]
    for (const attachmentId of input.attachmentIds) {
      const attachment = database
        .query("SELECT mime, path, origin_path FROM attachments WHERE id = ?")
        .get(attachmentId) as {
        mime: string
        path: string
        origin_path: string | null
      } | null
      if (!attachment)
        return { status: 400, json: { errorCode: "ATTACHMENT_NOT_FOUND", error: "Anexo não encontrado." } }
      const name = (attachment.origin_path ?? attachment.path).split(/[\\/]/).at(-1) || attachmentId
      parts.push(
        attachment.mime.startsWith("image/")
          ? { type: "image", attachmentId, mime: attachment.mime, name }
          : {
              type: "file",
              attachmentId,
              mime: attachment.mime,
              name,
            },
      )
    }
    const inserted = database.transaction(() => {
      const result = store.insertMessage({
        message: {
          id: `send:${nonce}`,
          threadId: input.threadId,
          parentId: input.parentId,
          role: "user",
          kind: "text",
          status: "complete",
          runId: null,
          text: input.text,
          parts,
          sender: null,
          source: "local",
          delivery: { clientNonce: nonce, deadline, status: "queued" },
        },
      })
      if (!result.success) return result
      database
        .query(
          "INSERT INTO send_journal(thread_id, client_nonce, request_json, message_id, deadline, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
        )
        .run(input.threadId, nonce, requestJson, result.message.id, deadline, Date.now(), Date.now())
      return result
    })()
    if (!inserted.success) return { status: 400, json: { errorCode: inserted.errorCode, error: inserted.error } }
    const entry = find(input.threadId, nonce)
    if (!entry) throw new Error("Send journal entry missing after insert")
    dispatch(entry)
    const response = reply(find(input.threadId, nonce) ?? entry)
    return { ...response, status: response.status === 200 ? 201 : response.status }
  }

  const sendMessage = (input: SendMessageInput): RouteResponse => {
    try {
      return send(input)
    } catch (error) {
      return errorResponse(new TouriError("TOURI-E2001", { cause: error }))
    }
  }

  const drainSendQueue = (): void => {
    const entries = database
      .query("SELECT * FROM send_journal WHERE status IN ('queued','sent') ORDER BY created_at, rowid")
      .all() as Entry[]
    for (const entry of entries) dispatch(entry)
  }
  return { sendMessage, drainSendQueue }
}
