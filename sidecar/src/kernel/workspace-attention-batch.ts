import type { Database } from "bun:sqlite"

type MessageRow = { thread_id: string; id: string; parts_json: string }
type RowId = { rowid: number }
type AttentionPart = {
  part_index: number
  type: string
  approval_id: string | null
  decision: string | null
  part_json: string
}
type PreparedMessage = { threadId: string; id: string; parts: AttentionPart[] }
export type WorkspaceAttentionBatchResult = { done: boolean; processed: number }

const batchSize = 50
const batchBudgetMs = 8

export const backfillWorkspaceAttentionBatch = (
  database: Database,
  limit = batchSize,
  now = performance.now.bind(performance),
): WorkspaceAttentionBatchResult => {
  const started = now()
  const progress = getBackfillProgress(database)
  if (!progress) return { done: true, processed: 0 }

  const version = getDataVersion(database)
  const maximum = Math.max(1, Math.min(batchSize, Math.floor(limit)))
  const rows = database
    .query("SELECT rowid FROM messages WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?")
    .all(progress.cursor, maximum) as RowId[]
  // Local accumulators retain only this bounded batch, without copying prepared records per row.
  const prepared: PreparedMessage[] = []
  let cursor = progress.cursor
  let processed = 0
  for (const row of rows) {
    if (processed && now() - started >= batchBudgetMs) break
    const message = getMessageAttention(database, row.rowid)
    if (message) prepared.push(message)
    cursor = row.rowid - 1
    processed += 1
  }

  // Large legacy JSON is read before taking the write lock. A concurrent commit
  // invalidates preparation, so stale parts never overwrite a live edit/deletion.
  return database
    .transaction(() => {
      if (getDataVersion(database) !== version || getBackfillProgress(database)?.cursor !== progress.cursor)
        return { done: false, processed: 0 }
      if (!rows.length) {
        database.query("DELETE FROM workspace_attention_backfill WHERE id = 1").run()
        return { done: true, processed: 0 }
      }

      prepared.forEach((message) => {
        message.parts.forEach((part) => {
          database
            .query(`INSERT OR REPLACE INTO workspace_message_attention
          (thread_id,message_id,part_index,type,approval_id,decision,part_json) VALUES (?,?,?,?,?,?,?)`)
            .run(
              message.threadId,
              message.id,
              part.part_index,
              part.type,
              part.approval_id,
              part.decision,
              part.part_json,
            )
        })
      })
      database.query("UPDATE workspace_attention_backfill SET cursor = ? WHERE id = 1").run(cursor)

      return { done: false, processed }
    })
    .immediate()
}

const getBackfillProgress = (database: Database): { cursor: number } | null =>
  database.query("SELECT cursor FROM workspace_attention_backfill WHERE id = 1").get() as { cursor: number } | null

const getDataVersion = (database: Database): number =>
  (database.query("PRAGMA data_version").get() as { data_version: number }).data_version

const getMessageAttention = (database: Database, rowid: number): PreparedMessage | null => {
  const message = database
    .query(`SELECT thread_id, id, parts_json FROM messages WHERE rowid = ?
    AND (instr(parts_json, '"approval"') > 0 OR instr(parts_json, '"notice"') > 0)`)
    .get(rowid) as MessageRow | null
  if (!message) return null

  const parts = database
    .query(`SELECT CAST(p.key AS INTEGER) AS part_index, json_extract(p.value, '$.type') AS type,
    json_extract(p.value, '$.approvalId') AS approval_id, json_extract(p.value, '$.decision') AS decision, p.value AS part_json
    FROM json_each(?) p WHERE json_extract(p.value, '$.type') IN ('approval', 'notice')`)
    .all(message.parts_json) as AttentionPart[]

  return { threadId: message.thread_id, id: message.id, parts }
}
