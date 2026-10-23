import type { Database } from "bun:sqlite"
import type { Kernel, Run, StoreApi } from "@touri/contracts"
import { yieldBackground } from "../kernel/background-task"
import { getStartupReply } from "../runtime/startup-runs"

/** A terminal snapshot must include durable deltas before it supersedes their replay cursor. */
export const recoverGroupReplies = async (kernel: Kernel, store: StoreApi, runs: Run[]): Promise<void> => {
  for (const run of runs) {
    await kernel.services.use("store.recovery")?.ensureThread(run.threadId)
    await recoverThreadReplies(kernel, store, run)
    await yieldBackground()
  }
}

const recoverThreadReplies = async (kernel: Kernel, store: StoreApi, run: Run): Promise<void> => {
  const database = kernel.db as Database
  const page = database.query(`SELECT id FROM messages INDEXED BY messages_run_created
    WHERE run_id IN (SELECT ? UNION ALL SELECT run_id FROM group_run_links WHERE turn_id=?)
      AND thread_id=? AND id>? AND status='streaming' ORDER BY id LIMIT 16`)
  // This task owns its keyset cursor; each page releases the event loop before reading more replies.
  let cursor = ""
  while (true) {
    const replies = page.all(run.id, run.id, run.threadId, cursor) as Array<{ id: string }>
    if (replies.length === 0) return

    for (const { id } of replies) await recoverReply(kernel, store, run.threadId, id)
    cursor = replies.at(-1)?.id ?? cursor
    await yieldBackground()
  }
}

const recoverReply = async (kernel: Kernel, store: StoreApi, threadId: string, messageId: string): Promise<void> => {
  const message = getStartupReply(store, { threadId, replyMessageId: messageId })
  if (!message) return

  const parts = message.parts.map((part) =>
    part.type === "approval" && part.decision === "pending" ? { ...part, decision: "expired" as const } : part,
  )
  const input: Parameters<StoreApi["updateMessage"]>[0] = {
    threadId,
    messageId,
    patch: {
      status: "failed",
      parts: [
        ...parts,
        {
          type: "notice",
          level: "warning",
          code: "app_restart",
          text: "O turno do grupo foi interrompido ao reiniciar o touri.",
        },
      ],
    },
  }
  const updated = store.updateMessageAsync ? await store.updateMessageAsync(input) : store.updateMessage(input)
  if (updated.success) kernel.publish({ type: "message.updated", message: updated.message })
}
