import type { Database } from "bun:sqlite"
import type { ApiRoutes, UiEvent } from "@touri/contracts"
import type { PerformanceStageRunner } from "./performance"
import { TRANSCRIPT_RETENTION } from "./transcript-storage"

type Progress = NonNullable<ApiRoutes["GET /health"]["res"]["historyMigration"]>
type ThreadProgress = { threadId: string; done: number; total: number; retentionCursor?: number }
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
    // Build the temporary ordering index incrementally. Scanning a fixed rowid
    // window also bounds work when most rows belong to other threads.
    database.exec(`CREATE TEMP TABLE IF NOT EXISTS history_backfill_order (
      row_id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, message_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS temp.history_backfill_created ON history_backfill_order(thread_id, created_at, row_id);
    CREATE TEMP TABLE IF NOT EXISTS history_backfill_scan (
      id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL, total INTEGER NOT NULL
    )`)
    const cached = database.query("SELECT cursor,total FROM history_backfill_scan WHERE id=1").get() as {
      cursor: number
      total: number
    } | null
    if (!cached) {
      database.exec("DELETE FROM history_backfill_order; DELETE FROM history_backfill_scan")
      database
        .query(`INSERT INTO history_backfill_scan(id,cursor,total)
        SELECT 1,0,COALESCE(MAX(rowid),0) FROM messages`)
        .run()
      return
    }
    if (cached.cursor < cached.total) {
      const window = database
        .query(`SELECT rowid AS row_id,thread_id,id,created_at,seq
        FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`)
        .all(cached.cursor, cached.total, Math.min(limit, 50)) as Array<{
        row_id: number
        thread_id: string
        id: string
        created_at: number
        seq: number
      }>
      window
        .filter((message) => message.seq === 0)
        .forEach((message) => {
          database
            .query("INSERT INTO history_backfill_order(row_id,thread_id,created_at,message_id) VALUES (?,?,?,?)")
            .run(message.row_id, message.thread_id, message.created_at, message.id)
        })
      database.query("UPDATE history_backfill_scan SET cursor=? WHERE id=1").run(window.at(-1)?.row_id ?? cached.total)
      return
    }
    const messages = database
      .query(`SELECT o.row_id, m.id, m.generation, m.updated_at
      FROM history_backfill_order o CROSS JOIN messages m
      WHERE o.thread_id = ? AND m.thread_id = o.thread_id AND m.id = o.message_id ORDER BY o.created_at,o.row_id LIMIT ?`)
      .all(progress.threadId, limit) as Array<{
      row_id: number
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
      const seq = progress.done + 1
      database.query("DELETE FROM history_backfill_order WHERE row_id=?").run(message.row_id)
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
      const retentionLimit = Math.min(limit, 50)
      const historical = database
        .query(`SELECT id,seq FROM transcript_entries
        WHERE thread_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
        .all(progress.threadId, progress.retentionCursor ?? 0, retainAfter, retentionLimit) as Array<{
        id: number
        seq: number
      }>
      const started = performance.now()
      let visited = 0
      for (const entry of historical) {
        if (visited && performance.now() - started >= 8) break

        const legacy = database
          .query("SELECT json_extract(event_json,'$.legacy') AS legacy FROM transcript_entries WHERE id=?")
          .get(entry.id) as { legacy: number | null }
        progress.retentionCursor = entry.seq
        visited += 1
        if (!legacy.legacy) continue

        database.query("UPDATE transcript_maintenance SET delete_before_id=? WHERE id=1").run(entry.id)
        database.query("DELETE FROM transcript_entries WHERE id=?").run(entry.id)
        database
          .query(`INSERT INTO transcript_retention(thread_id,through_seq) VALUES (?,?)
          ON CONFLICT(thread_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)`)
          .run(progress.threadId, entry.seq)
      }
      database.exec("UPDATE transcript_maintenance SET delete_before_id=0 WHERE id=1")
      // Keep the durable marker pending until the bounded cleanup traversal ends.
      if (visited < historical.length || historical.length === retentionLimit)
        progress.done = Math.max(0, progress.total - 1)
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
  runStage?: PerformanceStageRunner,
): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const step = (): void => {
    if (stopped) return
    try {
      const before = historyMigrationStatus(database)
      const progress = runStage
        ? runStage("history_backfill_batch", () => backfillHistoryBatch(database))
        : backfillHistoryBatch(database)
      if (progress.running) timer = setTimeout(step, progress.done === before.done ? 0 : 10)
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
