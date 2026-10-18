import type { Database } from "bun:sqlite"
import type { ApiRoutes, UiEvent } from "@touri/contracts"
import { TRANSCRIPT_RETENTION } from "./transcript-storage"

type Progress = NonNullable<ApiRoutes["GET /health"]["res"]["historyMigration"]>
type ThreadProgress = { threadId: string; done: number; total: number }
type StageRunner = <Value>(stage: string, action: () => Value) => Value
const prefix = "transcript.backfill.7.thread."

// Reserve each thread's historical sequence range before allowing live writers.
// This scans only the existing message key index, not message bodies, and writes
// one small settings row per thread. All message rewrites happen after listen.
export const prepareHistoryBackfill = (database: Database): void => {
  database.exec(`
    INSERT INTO settings(key, value_json, updated_at)
    SELECT '${prefix}' || thread_id,
      json_object('threadId', thread_id, 'done', 0, 'total', COUNT(*)), 0
      FROM messages GROUP BY thread_id;
    UPDATE threads SET updated_seq = json_extract(settings.value_json, '$.total')
      FROM settings WHERE settings.key = '${prefix}' || threads.id;
  `)
}

const threadRows = (database: Database): Array<{ key: string; value_json: string }> =>
  database
    .query("SELECT key, value_json FROM settings WHERE key >= ? AND key < ? ORDER BY key")
    .all(prefix, `${prefix}\uffff`) as Array<{ key: string; value_json: string }>

export const historyMigrationStatus = (database: Database): Progress => {
  let done = 0
  let total = 0
  for (const row of threadRows(database)) {
    const progress = JSON.parse(row.value_json) as ThreadProgress
    done += progress.done
    total += progress.total
  }
  return { running: done < total, done, total }
}

export const historyThreadPending = (database: Database, threadId: string): boolean => {
  const row = database.query("SELECT value_json FROM settings WHERE key = ?").get(`${prefix}${threadId}`) as {
    value_json: string
  } | null
  if (!row) return false
  const progress = JSON.parse(row.value_json) as ThreadProgress
  return progress.done < progress.total
}

// References locate the latest durable projection. Overlapping deltas remain
// safe because every message carries its updated sequence and text offsets.
export const hydrateHistoryEvent = (database: Database, eventJson: string): UiEvent => {
  const event = JSON.parse(eventJson) as UiEvent & {
    legacy?: boolean
    ref?: boolean
    threadId?: string
    messageId?: string
  }
  if (!event.legacy && !event.ref) return event
  const row = database
    .query("SELECT payload FROM transcript_message_events WHERE thread_id = ? AND id = ?")
    .get(event.threadId ?? "", event.messageId ?? "") as { payload: string } | null
  return row
    ? { type: event.type === "message.updated" ? "message.updated" : "message.created", ...JSON.parse(row.payload) }
    : { type: "transcript.resync" }
}

// The progress update and the rows it describes commit together. A quit/rollback
// retries that batch; already committed rows are never rewritten or duplicated.
export const backfillHistoryBatch = (database: Database, limit = 500): Progress => {
  database.transaction(() => {
    const row = threadRows(database).find((candidate) => {
      const progress = JSON.parse(candidate.value_json) as ThreadProgress
      return progress.done < progress.total
    })
    if (!row) return
    const progress = JSON.parse(row.value_json) as ThreadProgress
    // Cache only IDs/order for the active thread. Re-sorting and filtering its
    // large message bodies for every batch would make the backfill quadratic.
    // This temporary table is rebuilt from the durable marker after a restart.
    database.exec(`CREATE TEMP TABLE IF NOT EXISTS history_backfill_order (
      seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, message_id TEXT NOT NULL
    )`)
    const cached = database.query("SELECT thread_id FROM history_backfill_order LIMIT 1").get() as {
      thread_id: string
    } | null
    if (cached?.thread_id !== progress.threadId) {
      database.exec("DELETE FROM history_backfill_order")
      database
        .query(`INSERT INTO history_backfill_order(seq, thread_id, message_id)
          SELECT ? + ROW_NUMBER() OVER (ORDER BY created_at, rowid), thread_id, id
          FROM messages WHERE thread_id = ? AND seq = 0`)
        .run(progress.done, progress.threadId)
    }
    const messages = database
      .query(
        `SELECT o.seq, m.id, m.generation, m.updated_at FROM history_backfill_order o
         JOIN messages m ON m.thread_id = o.thread_id AND m.id = o.message_id
         WHERE o.seq > ? ORDER BY o.seq LIMIT ?`,
      )
      .all(progress.done, limit) as Array<{
      seq: number
      id: string
      generation: number
      updated_at: number
    }>
    const oldest = Date.now() - TRANSCRIPT_RETENTION.maxAgeMs
    const head = database.query("SELECT updated_seq FROM threads WHERE id = ?").get(progress.threadId) as {
      updated_seq: number
    } | null
    const retainAfter = Math.max(progress.total, head?.updated_seq ?? 0) - TRANSCRIPT_RETENTION.entriesPerThread
    const batchStarted = performance.now()
    let processed = 0
    for (const message of messages) {
      if (processed && performance.now() - batchStarted >= 8) break
      const seq = message.seq
      progress.done = seq
      processed += 1
      database
        .query(
          "UPDATE messages SET seq = ?, updated_seq = CASE WHEN updated_seq = 0 THEN ? ELSE updated_seq END WHERE thread_id = ? AND id = ?",
        )
        .run(seq, seq, progress.threadId, message.id)
      if (seq <= retainAfter || message.updated_at < oldest) {
        database
          .query(`INSERT INTO transcript_retention(thread_id, through_seq) VALUES (?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq)`)
          .run(progress.threadId, seq)
        continue
      }
      database
        .query("INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES (?, ?, ?, ?, ?)")
        .run(
          progress.threadId,
          seq,
          message.generation,
          JSON.stringify({ type: "message.created", threadId: progress.threadId, messageId: message.id, legacy: true }),
          message.updated_at,
        )
    }
    // A deleted legacy thread/message cannot leave the worker permanently pending.
    if (processed === messages.length && messages.length < limit) progress.done = progress.total
    if (progress.done === progress.total) {
      // Live revisions may have advanced since earlier batches. Remove only
      // historical references; unpublished live entries still need recovery.
      const cutoff = database
        .query(`SELECT MAX(id) AS id, MAX(seq) AS seq FROM transcript_entries
          WHERE thread_id = ? AND seq <= ? AND json_extract(event_json, '$.legacy') = 1`)
        .get(progress.threadId, retainAfter) as { id: number | null; seq: number | null }
      if (cutoff.id !== null && cutoff.seq !== null) {
        database.query("UPDATE transcript_maintenance SET delete_before_id = ? WHERE id = 1").run(cutoff.id)
        database
          .query(`DELETE FROM transcript_entries
            WHERE thread_id = ? AND seq <= ? AND json_extract(event_json, '$.legacy') = 1`)
          .run(progress.threadId, retainAfter)
        database
          .query(`INSERT INTO transcript_retention(thread_id, through_seq) VALUES (?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq)`)
          .run(progress.threadId, cutoff.seq)
        database.exec("UPDATE transcript_maintenance SET delete_before_id = 0 WHERE id = 1")
      }
    }
    database
      .query("UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(progress), Date.now(), row.key)
  })()
  return historyMigrationStatus(database)
}

export const startHistoryBackfill = (
  database: Database,
  onError: (error: unknown) => void,
  runStage?: StageRunner,
): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const step = (): void => {
    if (stopped) return
    try {
      const progress = runStage
        ? runStage("history_backfill_batch", () => backfillHistoryBatch(database))
        : backfillHistoryBatch(database)
      if (progress.running) timer = setTimeout(step, 10)
    } catch (error) {
      onError(error)
      // Keep the committed marker and retry without making startup fail.
      timer = setTimeout(step, 1000)
    }
  }
  // A macrotask lets module init, the handshake and initial requests finish first.
  timer = setTimeout(step, 25)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
