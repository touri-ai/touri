import { RUN_SNAPSHOT_SELECT } from "./persistence"

export const getThreadRunsQuery = (threadId: string, all = false) => ({
  sql: `WITH roots AS MATERIALIZED (
      SELECT id FROM runs WHERE thread_id = ? ORDER BY queued_at DESC, rowid DESC ${all ? "" : "LIMIT 50"}
    ), selected AS MATERIALIZED (
      SELECT id FROM roots
      UNION SELECT link.run_id FROM roots CROSS JOIN group_run_links link INDEXED BY group_run_links_turn
        WHERE link.turn_id = roots.id
    )
    ${RUN_SNAPSHOT_SELECT.replace(
      "SELECT r.*",
      `SELECT r.*, (SELECT visible_message_id FROM group_message_links
        WHERE source_thread_id = r.thread_id AND message_id = r.reply_message_id LIMIT 1) AS visible_reply_message_id`,
    ).replace("FROM runs r", "FROM selected candidate CROSS JOIN runs r")}
    WHERE r.id = candidate.id
    ORDER BY CASE WHEN r.thread_id = ? THEN 0 ELSE 1 END, r.queued_at DESC, r.rowid DESC`,
  bindings: [threadId, threadId],
})
