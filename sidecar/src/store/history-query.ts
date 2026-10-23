import { MESSAGE_PATH_CTE } from "../kernel/message-path"

export const THREAD_MESSAGES_SQL = "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC"

export const getHistoryQuery = (threadId: string, activeLeafId: string | null, all = false) => {
  if (all) return { sql: THREAD_MESSAGES_SQL, bindings: [threadId], activeLeafId, reverse: false }
  if (!activeLeafId) return { sql: "SELECT * FROM messages WHERE 0", bindings: [], activeLeafId, reverse: false }

  return {
    sql: `${MESSAGE_PATH_CTE} SELECT m.* FROM branch
      CROSS JOIN messages m WHERE m.thread_id = ? AND m.id = branch.id`,
    bindings: [threadId, activeLeafId, threadId, null, null, threadId],
    activeLeafId,
    reverse: true,
  }
}
