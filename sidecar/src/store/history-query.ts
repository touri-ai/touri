import { MESSAGE_PATH_CTE } from "../kernel/message-path"

export const THREAD_MESSAGES_SQL = "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC"

export type HistoryPage = { limit: number; before?: string; around?: string }

export const getHistoryPageQuery = (threadId: string, page: HistoryPage) => ({
  // The chronology index includes rowid as its final key, including equal-timestamp imports.
  sql: `SELECT * FROM messages WHERE thread_id = ? ${
    page.before || page.around
      ? `AND (created_at, rowid) ${page.before ? "<" : "<="}
    (SELECT created_at, rowid FROM messages WHERE thread_id = ? AND id = ?)`
      : ""
  }
    ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  bindings:
    page.before || page.around
      ? [threadId, threadId, page.before ?? page.around ?? "", page.limit + 1]
      : [threadId, page.limit + 1],
})

export const getHistoryQuery = (threadId: string, activeLeafId: string | null, all = false, page?: HistoryPage) => {
  if (page) return { ...getHistoryPageQuery(threadId, page), activeLeafId, reverse: true, pageLimit: page.limit }
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
