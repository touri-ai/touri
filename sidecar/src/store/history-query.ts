import { MESSAGE_PATH_CTE } from "../kernel/message-path"

export const THREAD_MESSAGES_SQL = "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC"

export type HistoryPage = { limit: number; before?: string; around?: string; contextId?: string; pathFrom?: string }

export const getHistoryPageQuery = (threadId: string, page: HistoryPage, keysOnly = false) => {
  const columns = keysOnly ? "id, thread_id, run_id" : "*"
  if (page.pathFrom) {
    const start = page.before ? "(SELECT parent_id FROM messages WHERE thread_id = ? AND id = ?)" : "?"
    return {
      sql: `WITH RECURSIVE branch(id,parent_id) AS (
        SELECT id,parent_id FROM messages WHERE thread_id = ? AND id = ${start}
        UNION SELECT m.id,m.parent_id FROM branch b CROSS JOIN messages m
          WHERE m.thread_id = ? AND m.id = b.parent_id
      ) SELECT ${keysOnly ? "m.id,m.thread_id,m.run_id" : "m.*"} FROM branch
        CROSS JOIN messages m WHERE m.thread_id = ? AND m.id = branch.id LIMIT ?`,
      bindings: page.before
        ? [threadId, threadId, page.before, threadId, threadId, page.limit + 1]
        : [threadId, page.pathFrom, threadId, threadId, page.limit + 1],
    }
  }
  // The chronology index includes rowid as its final key, including equal-timestamp imports.
  return {
    sql: `SELECT ${columns} FROM messages WHERE thread_id = ? ${
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
  }
}

export const getHistoryQuery = (threadId: string, activeLeafId: string | null, all = false, page?: HistoryPage) => {
  if (page)
    return {
      ...getHistoryPageQuery(threadId, page),
      activeLeafId,
      reverse: true,
      pageLimit: page.limit,
      ...(page.contextId ? { context: { threadId, messageId: page.contextId } } : {}),
    }
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

export const getHistoryPage = (query: Record<string, string>, activeLeafId: string | null): HistoryPage | undefined => {
  if (query.limit === undefined) return undefined
  const around = query.around || activeLeafId

  return {
    limit: Math.max(1, Math.min(50, Math.floor(Number(query.limit)) || 40)),
    ...(query.before ? { before: query.before } : {}),
    ...(around ? { around } : {}),
    ...(activeLeafId && around ? { pathFrom: around } : {}),
    ...(query.context === "true" && around ? { contextId: around } : {}),
  }
}
