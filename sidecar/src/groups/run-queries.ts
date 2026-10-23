// Restrict member executions to the same root window returned by the thread list.
// CROSS JOIN prevents a planner reversal into all historical member executions.
export const getGroupRunsSql = (all = false): string => `
  WITH roots AS MATERIALIZED (
    SELECT id FROM runs WHERE thread_id = ? ORDER BY queued_at DESC, rowid DESC ${all ? "" : "LIMIT 50"}
  )
  SELECT r.*, link.turn_id AS group_turn_id,
    continuation.previous_run_id AS browser_takeover_from_run_id
  FROM roots
  CROSS JOIN group_run_links link INDEXED BY group_run_links_turn
  CROSS JOIN runs r
  LEFT JOIN browser_takeover_continuations continuation ON continuation.run_id = r.id
  WHERE link.turn_id = roots.id AND r.id = link.run_id
  ORDER BY r.queued_at DESC, r.rowid DESC`
