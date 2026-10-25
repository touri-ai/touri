import type { Database } from "bun:sqlite"
import type { MessageHistoryContext } from "@touri/contracts"
import { MESSAGE_PATH_CTE } from "../kernel/message-path"

// Explicit historical search reads ancestry keys and sibling labels without hydrating other replies.
export const getMessageHistoryContext = (
  database: Database,
  threadId: string,
  activeLeafId: string | null,
  messageId: string,
  pageIds: string[] = [messageId],
): MessageHistoryContext => {
  const active =
    activeLeafId === messageId ||
    Boolean(
      database
        .query(`${MESSAGE_PATH_CTE} SELECT 1 FROM branch WHERE id = ? LIMIT 1`)
        .get(threadId, activeLeafId, threadId, messageId, messageId, messageId),
    )
  const slots = pageIds.map(() => "?").join(",")
  const siblings = pageIds.length
    ? (database
        .query(`SELECT DISTINCT m.id, m.thread_id AS threadId,
    m.parent_id AS parentId, m.role, m.kind, m.created_at AS createdAt
    FROM messages target CROSS JOIN messages m
    WHERE target.thread_id = ? AND target.id IN (${slots})
      AND m.thread_id = target.thread_id AND m.parent_id IS target.parent_id
      AND m.role = target.role AND m.kind <> 'notice'
    ORDER BY m.created_at,m.rowid LIMIT 200`)
        .all(threadId, ...pageIds) as MessageHistoryContext["siblings"])
    : []

  return { messageId, onActivePath: active, siblings }
}
