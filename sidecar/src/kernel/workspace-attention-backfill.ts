import type { Database } from "bun:sqlite"
import type { PerformanceStageRunner } from "./performance"

type MessageRow = { thread_id: string; id: string; parts_json: string }
type RowId = { rowid: number }
type BatchResult = { done: boolean; processed: number }

const batchSize = 50
const batchBudgetMs = 8

export const backfillWorkspaceAttentionBatch = (
  database: Database,
  limit = batchSize,
  now = performance.now.bind(performance),
): BatchResult => {
  const started = now()
  const maximum = Math.max(1, Math.min(batchSize, Math.floor(limit)))

  return database
    .transaction(() => {
      const progress = database.query("SELECT cursor FROM workspace_attention_backfill WHERE id = 1").get() as {
        cursor: number
      } | null
      if (!progress) return { done: true, processed: 0 }

      const rows = database
        .query("SELECT rowid FROM messages WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?")
        .all(progress.cursor, maximum) as RowId[]
      if (!rows.length) {
        database.query("DELETE FROM workspace_attention_backfill WHERE id = 1").run()
        return { done: true, processed: 0 }
      }

      let cursor = progress.cursor
      let processed = 0
      for (const row of rows) {
        if (processed && now() - started >= batchBudgetMs) break
        const message = database
          .query(`SELECT thread_id, id, parts_json FROM messages WHERE rowid = ?
            AND (instr(parts_json, '"approval"') > 0 OR instr(parts_json, '"notice"') > 0)`)
          .get(row.rowid) as MessageRow | null
        if (message)
          database
            .query(`INSERT OR REPLACE INTO workspace_message_attention
              SELECT ?, ?, CAST(p.key AS INTEGER), json_extract(p.value, '$.type'),
                json_extract(p.value, '$.approvalId'), json_extract(p.value, '$.decision'), p.value
              FROM json_each(?) p WHERE json_extract(p.value, '$.type') IN ('approval', 'notice')`)
            .run(message.thread_id, message.id, message.parts_json)
        cursor = row.rowid - 1
        processed += 1
      }
      database.query("UPDATE workspace_attention_backfill SET cursor = ? WHERE id = 1").run(cursor)

      return { done: false, processed }
    })
    .immediate()
}

const isSqliteBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))

const withoutBusyWait = <Value>(database: Database, operation: () => Value): Value => {
  const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
  database.exec("PRAGMA busy_timeout = 0")
  try {
    return operation()
  } finally {
    database.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
  }
}

export const startWorkspaceAttentionBackfill = (
  database: Database,
  onError: (error: unknown) => void,
  runStage?: PerformanceStageRunner,
): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let busyAttempts = 0
  const step = (): void => {
    if (stopped) return
    try {
      const result = runStage
        ? runStage("workspace_attention_backfill", () =>
            withoutBusyWait(database, () => backfillWorkspaceAttentionBatch(database)),
          )
        : withoutBusyWait(database, () => backfillWorkspaceAttentionBatch(database))
      busyAttempts = 0
      if (!result.done) timer = setTimeout(step, 10)
    } catch (error) {
      if (isSqliteBusy(error)) {
        const delayMs = Math.min(1_000, 50 * 2 ** Math.min(busyAttempts, 4))
        busyAttempts += 1
        timer = setTimeout(step, delayMs)
        return
      }
      onError(error)
      timer = setTimeout(step, 1000)
    }
  }

  // Give the listener and first requests a turn before scanning historical rows.
  timer = setTimeout(step, 25)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
