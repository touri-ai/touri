import type { Database } from "bun:sqlite"
import type { MessageHistoryContext } from "@touri/contracts"
import { MESSAGE_PATH_CTE } from "../kernel/message-path"

// Explicit historical search reads ancestry keys and sibling labels without hydrating other replies.
export const getMessageHistoryContext = (
  database: Database,
  threadId: string,
  activeLeafId: string | null,
  messageId: string,
): MessageHistoryContext => {
  const target = database
    .query("SELECT parent_id, role FROM messages WHERE thread_id = ? AND id = ?")
    .get(threadId, messageId) as { parent_id: string | null; role: string } | null
  const active = database
    .query(`${MESSAGE_PATH_CTE} SELECT 1 FROM branch WHERE id = ? LIMIT 1`)
    .get(threadId, activeLeafId, threadId, messageId, messageId, messageId)
  const siblings = target
    ? (database
        .query(
          `SELECT id, thread_id AS threadId, parent_id AS parentId, role, kind, created_at AS createdAt FROM messages WHERE thread_id = ? AND parent_id IS ? AND role = ? AND kind <> 'notice' ORDER BY created_at, rowid LIMIT 50`,
        )
        .all(threadId, target.parent_id, target.role) as MessageHistoryContext["siblings"])
    : []

  return { messageId, onActivePath: Boolean(active), siblings }
}
