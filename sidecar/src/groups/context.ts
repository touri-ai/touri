import type { Database } from "bun:sqlite"

export const GROUP_CONTEXT_SQL = `WITH candidates AS MATERIALIZED (
  SELECT rowid, seq FROM (
    SELECT rowid, seq FROM messages
    WHERE thread_id = ?1 AND role = 'user'
      AND seq <= (SELECT seq FROM messages WHERE thread_id = ?1 AND id = ?2)
    ORDER BY seq DESC LIMIT 80
  )
  UNION ALL
  SELECT rowid, seq FROM (
    SELECT rowid, seq FROM messages WHERE thread_id = ?1 AND role <> 'user'
    ORDER BY seq DESC LIMIT 80
  )
), recent AS MATERIALIZED (
  SELECT rowid, seq FROM candidates ORDER BY seq DESC LIMIT 80
)
SELECT m.role, m.text, m.sender_json FROM recent
JOIN messages m ON m.rowid = recent.rowid ORDER BY recent.seq DESC`

type ContextRow = { role: string; text: string; sender_json: string | null }

export const getGroupContextRows = (
  database: Database,
  threadId: string,
  requestMessageId: string | null,
): ContextRow[] => database.query(GROUP_CONTEXT_SQL).all(threadId, requestMessageId) as ContextRow[]
