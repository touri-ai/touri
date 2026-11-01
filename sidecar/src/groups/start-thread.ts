import type { Database } from "bun:sqlite"
import type { Kernel, Message, Thread, ToolContext, ToolRegistration } from "@touri/contracts"
import { getDelegation } from "./security"

export const startMessageThread = (kernel: Kernel, parent: Thread, message: Message, title?: string): Thread => {
  const db = kernel.db as Database
  const store = kernel.services.use("store.api")
  if (!store || message.threadId !== parent.id || !["user", "assistant"].includes(message.role))
    throw new Error("Mensagem indisponível")

  return db
    .transaction(() => {
      const existing = db
        .query("SELECT id FROM threads WHERE parent_thread_id = ? AND anchor_message_id = ?")
        .get(parent.id, message.id) as {
        id: string
      } | null
      if (existing) {
        const thread = store.getThread({ threadId: existing.id, includeArchived: true })
        if (thread && !thread.archivedAt) return thread
        if (thread) {
          db.query("UPDATE threads SET archived_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), thread.id)
          const restored = { ...thread, archivedAt: null }
          kernel.publish({ type: "thread.updated", thread: restored })
          return restored
        }
      }
      const result = store.createThread({
        botId: parent.botId,
        kind: "chat",
        title: title?.trim().slice(0, 200) || message.text.trim().slice(0, 80) || "Thread",
        parentThreadId: parent.id,
        anchorMessageId: message.id,
        ...(parent.groupId ? { groupId: parent.groupId } : {}),
        ...(parent.ownerPersonId ? { ownerPersonId: parent.ownerPersonId } : {}),
      })
      if (!result.success) throw new Error(result.error)
      // Copy only the visible text: tool output and approvals never become instructions or permissions.
      const context = store.insertMessage({
        message: {
          id: kernel.newId(),
          threadId: result.thread.id,
          parentId: null,
          role: message.role,
          kind: "text",
          status: "complete",
          runId: null,
          text: message.text,
          parts: message.parts.filter((part) => part.type === "text" || part.type === "image" || part.type === "file"),
          sender: message.sender,
          source: "local",
        },
      })
      if (!context.success) throw new Error(context.error)
      return store.getThread({ threadId: result.thread.id }) ?? result.thread
    })
    .immediate()
}

/** Accept only a direct imperative in the current human message; quotes and embedded documents fail closed. */
export const hasExplicitThreadRequest = (text: string): boolean => {
  if (text.length > 8000 || /[`"“”<>]|(^|\n)\s*>/m.test(text)) return false
  if (/\b(não|nao|never|don't|do not|sem)\b/i.test(text)) return false

  return /^(?:@[\p{L}\d_-]+\s+)?(?:por favor[, ]+|please\s+)?(?:crie|cria|criar|abra|abre|abrir|inicie|inicia|iniciar|create|open|start)\s+(?:(?:uma|a|nova|new)\s+){0,2}thread\b/iu.test(
    text.trim(),
  )
}

export const getThreadRequest = (
  kernel: Kernel,
  ctx: Pick<ToolContext, "threadId" | "botId"> & { runId?: string | null },
) => {
  const store = kernel.services.use("store.api")
  const run = kernel.services.use("runtime.activeRun")?.({ threadId: ctx.threadId })
  const thread = store?.getThread({ threadId: ctx.threadId })
  if (
    !store ||
    !thread ||
    !run ||
    !["starting", "running"].includes(run.status) ||
    (ctx.runId !== undefined && run.id !== ctx.runId) ||
    run.botId !== ctx.botId ||
    !run.requestMessageId
  )
    return null
  if (
    run.trigger !== "user" ||
    run.routineRunId ||
    (run.origin && run.origin !== "message") ||
    getDelegation(kernel, ctx.threadId)
  )
    return null
  const db = kernel.db as Database
  if (
    db
      .query(
        "SELECT 1 FROM run_continuations WHERE run_id = ? UNION ALL SELECT 1 FROM browser_takeover_continuations WHERE run_id = ? LIMIT 1",
      )
      .get(run.id, run.id)
  )
    return null
  const parent = thread.groupThreadId ? store.getThread({ threadId: thread.groupThreadId }) : thread
  if (!parent) return null
  if (
    parent.groupId &&
    !db.query("SELECT 1 FROM group_members WHERE group_id = ? AND bot_id = ?").get(parent.groupId, ctx.botId)
  )
    return null
  const linked = thread.groupThreadId
    ? (db
        .query(
          "SELECT r.id, r.request_message_id, r.trigger, r.routine_run_id FROM group_run_links l JOIN runs r ON r.id = l.turn_id WHERE l.run_id = ? AND l.depth = 0 AND r.thread_id = ?",
        )
        .get(run.id, parent.id) as {
        id: string
        request_message_id: string
        trigger: string
        routine_run_id: string | null
      } | null)
    : null
  if (thread.groupThreadId && (linked?.trigger !== "user" || linked.routine_run_id)) return null
  const humanRunId = linked?.id ?? run.id
  const canAccess = kernel.services.use("work.canAccessThread")
  const personId = run.requesterPersonId ?? kernel.services.use("work.personForRun")?.(humanRunId)
  const role = kernel.services.use("work.isAdminRun")?.(humanRunId) ? "admin" : "member"
  if (canAccess && (!personId || !canAccess({ personId, role, threadId: parent.id }))) return null
  const message = store.getPathMessage?.({
    threadId: parent.id,
    messageId: linked?.request_message_id ?? run.requestMessageId,
  })
  if (
    message?.role !== "user" ||
    message.parts.some((part) => part.type !== "text") ||
    !hasExplicitThreadRequest(message.text)
  )
    return null
  if (message.sender && message.sender.kind !== "person") return null

  return { thread: parent, message }
}

export const createThreadTool = (kernel: Kernel): ToolRegistration => ({
  name: "thread_create",
  group: "core",
  handler: async ({ ctx, args }) => {
    const request = getThreadRequest(kernel, ctx)
    if (!ctx.runId || !request || ctx.signal.aborted)
      return {
        success: false,
        errorCode: "DENIED",
        error:
          "Peça explicitamente para criar uma thread na mensagem atual. Rotinas e delegações não podem criar threads.",
      }
    const input = args && typeof args === "object" && !Array.isArray(args) ? (args as { title?: unknown }) : {}
    const title = typeof input.title === "string" ? input.title : undefined
    const thread = startMessageThread(kernel, request.thread, request.message, title)

    return {
      success: true,
      structured: { thread },
      content: [{ type: "text", text: `Thread criada: ${thread.title}` }],
    }
  },
})
