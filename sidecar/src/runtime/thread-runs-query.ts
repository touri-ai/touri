import { getHistoryPageQuery, type HistoryPage } from "../store/history-query"
import { RUN_SNAPSHOT_SELECT } from "./persistence"

export const getThreadRunsQuery = (threadId: string, all = false, messageIds?: string[], page?: HistoryPage) => {
  const roots = getRunRootsQuery(threadId, all, messageIds, page)
  const scoped = Boolean(messageIds || page)
  const children = `SELECT link.run_id FROM roots CROSS JOIN group_run_links link INDEXED BY group_run_links_turn
    ${scoped ? "CROSS JOIN runs child" : ""}
    WHERE link.turn_id = roots.id ${scoped ? "AND child.id = link.run_id AND child.status IN ('queued','starting','running') LIMIT 50" : ""}`

  return {
    sql: `WITH ${roots.page ? `page AS MATERIALIZED (${roots.page}),` : ""}
      roots AS MATERIALIZED (${roots.sql}), selected AS MATERIALIZED (
        SELECT id FROM roots UNION SELECT run_id AS id FROM (${children})
      )
      ${RUN_SNAPSHOT_SELECT.replace(
        "SELECT r.*",
        `SELECT r.*, (SELECT visible_message_id FROM group_message_links
          WHERE source_thread_id = r.thread_id AND message_id = r.reply_message_id LIMIT 1) AS visible_reply_message_id`,
      ).replace("FROM runs r", "FROM selected candidate CROSS JOIN runs r")}
      WHERE r.id = candidate.id
      ORDER BY CASE WHEN r.thread_id = ? THEN 0 ELSE 1 END, r.queued_at DESC, r.rowid DESC`,
    bindings: [...roots.bindings, threadId],
  }
}

const getRunRootsQuery = (threadId: string, all: boolean, messageIds?: string[], page?: HistoryPage) => {
  if (page) {
    const query = getHistoryPageQuery(threadId, page)
    return {
      page: query.sql.replace("SELECT * FROM messages", "SELECT id, thread_id, run_id FROM messages"),
      sql: `SELECT run_id AS id FROM page WHERE run_id IS NOT NULL
        UNION SELECT r.id FROM page m CROSS JOIN runs r INDEXED BY runs_request
        WHERE r.thread_id = m.thread_id AND r.request_message_id = m.id`,
      bindings: [...query.bindings.slice(0, -1), page.limit],
    }
  }
  if (messageIds) {
    const slots = messageIds.map(() => "?").join(",")
    return {
      page: null,
      sql: `SELECT run_id AS id FROM messages WHERE thread_id = ? AND id IN (${slots}) AND run_id IS NOT NULL
        UNION SELECT r.id FROM messages m CROSS JOIN runs r INDEXED BY runs_request
        WHERE m.thread_id = ? AND m.id IN (${slots}) AND r.thread_id = m.thread_id AND r.request_message_id = m.id`,
      bindings: [threadId, ...messageIds, threadId, ...messageIds],
    }
  }

  return {
    page: null,
    sql: `SELECT id FROM runs WHERE thread_id = ? ORDER BY queued_at DESC, rowid DESC ${all ? "" : "LIMIT 50"}`,
    bindings: [threadId],
  }
}
