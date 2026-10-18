import type { Database } from "bun:sqlite"

// UNION deduplicates ids even in a damaged cyclic tree. Only ancestry keys are
// traversed; historical output bodies must not be loaded just to find a request.
export const MESSAGE_PATH_CTE = `WITH RECURSIVE branch(id, parent_id) AS (
  SELECT id, parent_id FROM messages WHERE thread_id = ? AND id = ?
  UNION
  SELECT m.id, m.parent_id FROM messages m JOIN branch b ON m.id = b.parent_id
  WHERE m.thread_id = ? AND (? IS NULL OR b.id <> ?)
)`

export const getPathIds = (
  database: Database,
  threadId: string,
  leafId: string,
  limit = -1,
  throughId: string | null = null,
): Array<string> =>
  (
    database
      .query(`${MESSAGE_PATH_CTE} SELECT id FROM branch LIMIT ?`)
      .all(threadId, leafId, threadId, throughId, throughId, limit) as Array<{ id: string }>
  ).map((row) => row.id)

export const hasPathHistory = (
  database: Database,
  threadId: string,
  leafId: string,
  requestId: string | null,
): boolean =>
  !!database
    .query(`${MESSAGE_PATH_CTE}
    SELECT 1 FROM branch b JOIN messages m ON m.thread_id = ? AND m.id = b.id
    WHERE m.id IS NOT ? AND m.role IN ('user', 'assistant') LIMIT 1`)
    .get(threadId, leafId, threadId, null, null, threadId, requestId)
