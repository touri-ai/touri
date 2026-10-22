import type { Database } from "bun:sqlite"
import type { Kernel, NoticePart } from "@touri/contracts"

const EXPIRY_NOTICE: NoticePart = {
  type: "notice",
  level: "warning",
  code: "run_failed",
  text: "No one took over in time. Ask again when you can.",
}

export const reportBrowserHandoffExpiry = ({
  kernel,
  runId,
  originalRunId,
}: {
  kernel: Kernel
  runId: string
  originalRunId: string
}): void => {
  const database = kernel.db as Database
  const store = kernel.services.use("store.api")
  if (!store?.getPathMessage) return

  // Only the current reply and its shared-channel projection are touched, by indexed IDs.
  const replies = database
    .query(`SELECT r.thread_id, r.reply_message_id AS message_id FROM runs r
      WHERE r.id IN (?,?) AND r.reply_message_id IS NOT NULL
      UNION
      SELECT owner.group_thread_id AS thread_id, link.visible_message_id AS message_id FROM runs r
      JOIN threads owner ON owner.id = r.thread_id
      JOIN group_message_links link ON link.message_id = r.reply_message_id AND link.source_thread_id = r.thread_id
      WHERE r.id IN (?,?) AND owner.group_thread_id IS NOT NULL LIMIT 4`)
    .all(runId, originalRunId, runId, originalRunId) as Array<{ thread_id: string; message_id: string }>

  replies.forEach((reply) => {
    const message = store.getPathMessage?.({
      threadId: reply.thread_id,
      messageId: reply.message_id,
      leafId: reply.message_id,
    })
    if (
      !message ||
      message.parts.some(
        (part) => part.type === "notice" && part.code === EXPIRY_NOTICE.code && part.text === EXPIRY_NOTICE.text,
      )
    )
      return

    const updated = store.updateMessage({
      threadId: message.threadId,
      messageId: message.id,
      patch: { parts: message.parts.concat(EXPIRY_NOTICE) },
    })
    if (updated.success) kernel.publish({ type: "message.updated", message: updated.message })
  })
}
