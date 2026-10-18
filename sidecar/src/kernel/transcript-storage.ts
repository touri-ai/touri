import type { Database } from "bun:sqlite"
import type { MessagePart, UiEvent } from "@touri/contracts"
import { refreshMessageSearch } from "./message-search"

type Delta = Extract<UiEvent, { type: "message.delta" }>
type StreamEvent = Delta | Extract<UiEvent, { type: "message.parts" }>
type Projection = {
  id: string
  thread_id: string
  text: string
  parts_json: string
  updated_seq: number
  generation: number
  updated_at: number
}

type ProjectionTarget = { threadId: string; messageId: string }

// Snapshots are mutable projections. The small, durable entries remain the source of
// uncheckpointed text, including after a crash. Publishing a projection adds no event.
export const materializeTranscriptBatch = (database: Database, threadId?: string): boolean =>
  database.transaction(() => {
    const filter = threadId ? "WHERE thread_id=?" : ""
    const statement = database.query(`SELECT thread_id,message_id FROM transcript_pending_deltas
      ${filter} ORDER BY thread_id,message_id LIMIT 1`)
    const pending = (threadId ? statement.get(threadId) : statement.get()) as {
      thread_id: string
      message_id: string
    } | null
    if (!pending) return false

    const target = { threadId: pending.thread_id, messageId: pending.message_id }
    const snapshot = database
      .query("SELECT updated_seq FROM messages WHERE thread_id=? AND id=?")
      .get(target.threadId, target.messageId) as { updated_seq: number } | null
    if (!snapshot) {
      clearPendingProjection(database, target)
      return true
    }
    const delta = database
      .query(`SELECT seq FROM transcript_entries INDEXED BY transcript_delta_message
      WHERE thread_id=? AND json_extract(event_json,'$.messageId')=?
        AND json_extract(event_json,'$.type')='message.delta' ORDER BY seq DESC LIMIT 1`)
      .get(target.threadId, target.messageId) as { seq: number } | null
    const part = database
      .query(`SELECT e.seq FROM transcript_part_entries part INDEXED BY transcript_part_message
      CROSS JOIN transcript_entries e WHERE part.thread_id=? AND part.message_id=?
        AND e.id=part.entry_id ORDER BY part.entry_id DESC LIMIT 1`)
      .get(target.threadId, target.messageId) as { seq: number } | null
    const head = Math.max(delta?.seq ?? 0, part?.seq ?? 0)
    if (head <= snapshot.updated_seq) {
      clearPendingProjection(database, target)
      return true
    }
    database.exec(`CREATE TEMP TABLE IF NOT EXISTS transcript_recovery_scan (
      thread_id TEXT NOT NULL,message_id TEXT NOT NULL,cursor INTEGER NOT NULL,
      PRIMARY KEY(thread_id,message_id)
    )`)
    const saved = database
      .query("SELECT cursor FROM transcript_recovery_scan WHERE thread_id=? AND message_id=?")
      .get(target.threadId, target.messageId) as { cursor: number } | null
    const cursor = Math.max(saved?.cursor ?? 0, snapshot.updated_seq)
    // Bound rows BEFORE JSON extraction/filtering or ordering. A LIMIT after
    // sorting both entire per-message streams would still read their full history.
    const rows = database
      .query(`SELECT id AS entry_id,seq AS delta_seq,at,? AS id,thread_id
      FROM transcript_entries WHERE thread_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 128`)
      .all(target.messageId, target.threadId, cursor, head) as Array<Omit<ProjectionEntry, "event_json">>
    // Local replay/cursor accumulators avoid materializing a window of legacy
    // full snapshots; one large historical body is fetched and released at a time.
    const relevant: ProjectionEntry[] = []
    const started = performance.now()
    let next = rows.length ? cursor : head
    for (const row of rows) {
      if (next !== cursor && performance.now() - started >= 8) break

      const body = database.query("SELECT event_json FROM transcript_entries WHERE id=?").get(row.entry_id) as {
        event_json: string
      }
      const event = JSON.parse(body.event_json) as { type: string; messageId?: string }
      next = row.delta_seq
      if (event.messageId !== target.messageId || (event.type !== "message.delta" && event.type !== "message.parts"))
        continue

      relevant.push({ ...row, event_json: body.event_json })
    }
    applyTranscriptEntries(database, relevant, target, next >= head)
    database
      .query(`INSERT INTO transcript_recovery_scan(thread_id,message_id,cursor) VALUES (?,?,?)
      ON CONFLICT(thread_id,message_id) DO UPDATE SET cursor=excluded.cursor`)
      .run(target.threadId, target.messageId, next)
    if (next >= head)
      database
        .query("DELETE FROM transcript_recovery_scan WHERE thread_id=? AND message_id=?")
        .run(target.threadId, target.messageId)
    return true
  })()

export const materializeTranscript = (database: Database, target?: ProjectionTarget): void => {
  if (!database.query("SELECT 1 FROM transcript_pending_deltas LIMIT 1").get()) return
  database.transaction(() => {
    const targetFilter = target ? "AND p.thread_id = ? AND p.message_id = ?" : ""
    const statement = database.query(
      // Drive both indexed stream lookups from the small dirty-message queue.
      `SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_pending_deltas p
         CROSS JOIN messages m
         CROSS JOIN transcript_entries e INDEXED BY transcript_delta_message
         WHERE m.thread_id = p.thread_id AND m.id = p.message_id
           ${targetFilter}
           AND e.thread_id = p.thread_id AND json_extract(e.event_json, '$.messageId') = p.message_id
           AND json_extract(e.event_json, '$.type') = 'message.delta' AND e.seq > m.updated_seq
         UNION ALL
         SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_pending_deltas p
         CROSS JOIN messages m
         CROSS JOIN transcript_part_entries part INDEXED BY transcript_part_message
         CROSS JOIN transcript_entries e
         WHERE m.thread_id = p.thread_id AND m.id = p.message_id
           ${targetFilter}
           AND part.thread_id = p.thread_id AND part.message_id = p.message_id
           AND e.id = part.entry_id AND e.seq > m.updated_seq
         ORDER BY entry_id`,
    )
    const rows = (
      target ? statement.all(target.threadId, target.messageId, target.threadId, target.messageId) : statement.all()
    ) as ProjectionEntry[]
    applyTranscriptEntries(database, rows, target)
  })()
}

type ProjectionEntry = {
  entry_id: number
  id: string
  thread_id: string
  delta_seq: number
  at: number
  event_json: string
}

const applyTranscriptEntries = (
  database: Database,
  rows: ProjectionEntry[],
  target?: ProjectionTarget,
  complete = true,
): void => {
  // Only private projection copies and the local accumulator change in this
  // replay loop; copying the growing text/parts for each delta would be quadratic.
  const projections = new Map<string, Projection & { parts: MessagePart[] }>()
  for (const row of rows) {
    const key = JSON.stringify([row.thread_id, row.id])
    let projection = projections.get(key)
    if (!projection) {
      const snapshot = database
        .query("SELECT * FROM messages WHERE thread_id = ? AND id = ?")
        .get(row.thread_id, row.id) as Projection
      projection = { ...snapshot, parts: JSON.parse(snapshot.parts_json) as MessagePart[] }
    }
    const event = JSON.parse(row.event_json) as StreamEvent
    if (event.type === "message.parts") {
      for (const patch of event.parts) {
        if (patch.partIndex > projection.parts.length) throw new Error("Transcript part has a gap")
        projection.parts[patch.partIndex] = patch.part
      }
      projection.text = projection.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    } else {
      const part = projection.parts[event.partIndex]
      const text = part?.type === "text" || part?.type === "reasoning" ? part.text : ""
      if (event.offset === undefined || event.offset > text.length) throw new Error("Transcript delta has a gap")
      const suffix = event.delta.slice(Math.max(0, text.length - event.offset))
      const partType = event.partType ?? (part?.type === "reasoning" ? "reasoning" : "text")
      projection.parts[event.partIndex] = {
        ...(part?.type === partType ? part : {}),
        type: partType,
        text: text + suffix,
      }
      if (partType === "text") projection.text += suffix
    }
    projection.updated_seq = row.delta_seq
    projection.generation = event.generation ?? projection.generation
    projection.updated_at = row.at
    projections.set(key, projection)
  }
  if (!projections.size) {
    if (complete) clearPendingProjection(database, target)
    return
  }
  database.exec("UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1")
  for (const projection of projections.values()) {
    database
      .query(
        `UPDATE messages SET text = ?, parts_json = ?, updated_seq = ?, generation = ?, updated_at = ?
           WHERE thread_id = ? AND id = ?`,
      )
      .run(
        projection.text,
        JSON.stringify(projection.parts),
        projection.updated_seq,
        projection.generation,
        projection.updated_at,
        projection.thread_id,
        projection.id,
      )
    refreshMessageSearch(database, { threadId: projection.thread_id, id: projection.id, text: projection.text })
  }
  database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1")
  if (complete) clearPendingProjection(database, target)
}

const clearPendingProjection = (database: Database, target?: ProjectionTarget): void => {
  if (!target) {
    database.exec("DELETE FROM transcript_pending_deltas")
    return
  }

  database
    .query("DELETE FROM transcript_pending_deltas WHERE thread_id = ? AND message_id = ?")
    .run(target.threadId, target.messageId)
}

const hasPendingRetentionProjection = (database: Database, threadId: string, cutoff: number): boolean => {
  const delta = database
    .query(`SELECT 1 FROM transcript_pending_deltas p
    CROSS JOIN messages m CROSS JOIN transcript_entries e INDEXED BY transcript_delta_message
    WHERE p.thread_id = ? AND m.thread_id = p.thread_id AND m.id = p.message_id AND m.updated_seq < ?
      AND e.thread_id = p.thread_id AND json_extract(e.event_json, '$.messageId') = p.message_id
      AND json_extract(e.event_json, '$.type') = 'message.delta'
      AND e.seq > m.updated_seq AND e.seq <= ? LIMIT 1`)
    .get(threadId, cutoff, cutoff)
  if (delta) return true

  return Boolean(
    database
      .query(`SELECT 1 FROM transcript_pending_deltas p
    CROSS JOIN messages m CROSS JOIN transcript_part_entries part INDEXED BY transcript_part_message
    CROSS JOIN transcript_entries e
    WHERE p.thread_id = ? AND m.thread_id = p.thread_id AND m.id = p.message_id AND m.updated_seq < ?
      AND part.thread_id = p.thread_id AND part.message_id = p.message_id AND e.id = part.entry_id
      AND e.seq > m.updated_seq AND e.seq <= ? LIMIT 1`)
      .get(threadId, cutoff, cutoff),
  )
}

export const TRANSCRIPT_RETENTION = { events: 10_000, entriesPerThread: 2_000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }

export const botReplayRows = (database: Database, botId: string): Array<{ seq: number; event_json: string }> =>
  database
    .query(`SELECT seq,event_json FROM ui_event_log e WHERE EXISTS (
    SELECT 1 FROM json_tree(e.event_json) j WHERE
      (j.key IN ('botId','bot_id','ownerBotId','vmBotId') AND j.value = ?)
      OR (j.key IN ('threadId','thread_id','sourceThreadId','groupThreadId') AND j.value IN (SELECT id FROM threads WHERE bot_id=?))
      OR (j.fullkey = '$.bot.id' AND j.value=?)
      OR (j.fullkey = '$.thread.id' AND j.value IN (SELECT id FROM threads WHERE bot_id=?))
      OR (j.key = 'processId' AND j.value IN (SELECT id FROM processes WHERE vm_bot_id=?))
      OR (j.fullkey = '$.spec.id' AND j.value IN (SELECT id FROM processes WHERE vm_bot_id=?))
      OR (j.key = 'tabId' AND j.value IN (SELECT id FROM browser_tabs WHERE owner_bot_id=?))
  )`)
    .all(botId, botId, botId, botId, botId, botId, botId) as Array<{ seq: number; event_json: string }>

/** Called before removing the bot's thread rows, within the deletion transaction. */
export const purgeBotReplay = (database: Database, botId: string): void => {
  purgeReplayRows(database, botReplayRows(database, botId))
}

/** Called before removing owned rows, within the deletion transaction. */
export const purgeReplayRows = (database: Database, rows: Array<{ seq: number }>): void => {
  const floor = rows.reduce((maximum, row) => Math.max(maximum, row.seq), 0)
  if (!floor) return
  database.query("UPDATE transcript_maintenance SET ui_delete_before_seq=? WHERE id=1").run(floor)
  rows.forEach((row) => {
    database.query("DELETE FROM ui_event_log WHERE seq=?").run(row.seq)
  })
  database
    .query("UPDATE schema_meta SET value=CAST(MAX(CAST(value AS INTEGER),?) AS TEXT) WHERE key='ui_event_floor_seq'")
    .run(floor)
  database.exec("UPDATE transcript_maintenance SET ui_delete_before_seq=0 WHERE id=1")
}

export const compactTranscript = ({
  database,
  events = TRANSCRIPT_RETENTION.events,
  entriesPerThread = TRANSCRIPT_RETENTION.entriesPerThread,
  maxAgeMs = TRANSCRIPT_RETENTION.maxAgeMs,
  now = Date.now(),
}: {
  database: Database
  events?: number
  entriesPerThread?: number
  maxAgeMs?: number
  now?: number
}): boolean => {
  const upgrade = database.query("SELECT value FROM schema_meta WHERE key = 'storage_upgrade_22'").get() as {
    value: string
  } | null
  if (upgrade && upgrade.value !== "done") return false
  // Both journals receive the same writes, so each needs its own bounded budget.
  // Callers doing manual maintenance yield before draining another batch.
  const limit = 256
  return database.transaction(() => {
    const checkpoint = Number(
      (
        database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
          value: string
        }
      ).value,
    )
    // Read only a small window from the age index. Grouping every expired entry
    // before applying a LIMIT would still scan the entire historical backlog.
    const aged = database
      .query(`SELECT thread_id, seq, id FROM transcript_entries INDEXED BY transcript_entries_age
        WHERE at < ? ORDER BY at, id LIMIT ?`)
      .all(now - maxAgeMs, limit) as Array<{ thread_id: string; seq: number; id: number }>
    const cutoffs = new Map<string, number>()
    for (const row of aged)
      if (row.id <= checkpoint) cutoffs.set(row.thread_id, Math.max(cutoffs.get(row.thread_id) ?? 0, row.seq))
    database.exec(`CREATE TEMP TABLE IF NOT EXISTS transcript_retention_cursor (
      id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL
    ); INSERT OR IGNORE INTO transcript_retention_cursor VALUES (1,0)`)
    const cursor = (
      database.query("SELECT cursor FROM transcript_retention_cursor WHERE id=1").get() as { cursor: number }
    ).cursor
    // One reverse-history seek per pass: gathering cutoffs for hundreds of
    // threads before the deletion budget would still monopolize a cold store.
    const threadLimit = 1
    const threads = database
      .query(`SELECT rowid AS cursor,id,updated_seq FROM threads
      WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .all(cursor, threadLimit) as Array<{
      cursor: number
      id: string
      updated_seq: number
    }>
    for (const thread of threads.filter((thread) => thread.updated_seq > entriesPerThread)) {
      // A bounded reverse seek replaces ranking every retained historical row.
      const excess = database
        .query(`SELECT seq, id FROM transcript_entries
          WHERE thread_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`)
        .get(thread.id, entriesPerThread) as { seq: number; id: number } | null
      if (excess && excess.id <= checkpoint) cutoffs.set(thread.id, Math.max(cutoffs.get(thread.id) ?? 0, excess.seq))
    }
    // Old history must not checkpoint unrelated growing replies on every retention batch.
    const pendingThread = Array.from(cutoffs).find(([threadId, cutoff]) =>
      hasPendingRetentionProjection(database, threadId, cutoff),
    )
    if (pendingThread) {
      materializeTranscriptBatch(database, pendingThread[0])
      const needsAnotherCheckpoint = Array.from(cutoffs).some(([threadId, cutoff]) =>
        hasPendingRetentionProjection(database, threadId, cutoff),
      )
      if (needsAnotherCheckpoint) return true
    }
    let removed = 0
    let more = false
    const started = performance.now()
    for (const [threadId, cutoff] of cutoffs) {
      if (removed >= limit || (removed > 0 && performance.now() - started >= 8)) {
        more = true
        break
      }
      // Bound the actual deletion prefix too: one old timestamp may identify a
      // cutoff far beyond the oldest 256 rows in this thread.
      const rows = database
        .query(`SELECT id, seq FROM transcript_entries
          WHERE thread_id = ? AND seq <= ? ORDER BY seq LIMIT ?`)
        .all(threadId, cutoff, limit - removed) as Array<{ id: number; seq: number }>
      let through = 0
      for (const row of rows) {
        if (removed > 0 && performance.now() - started >= 8) {
          more = true
          break
        }
        // An unpublished entry can share an older reserved thread sequence.
        // Deleting exact ids preserves that tail even when sequence/id differ.
        if (row.id > checkpoint) continue
        database.query("UPDATE transcript_maintenance SET delete_before_id = ? WHERE id = 1").run(row.id)
        database.query("DELETE FROM transcript_entries WHERE id = ?").run(row.id)
        database.query("DELETE FROM rejections WHERE thread_id = ? AND seq = ?").run(threadId, row.seq)
        through = row.seq
        removed++
      }
      if (through)
        database
          .query(`INSERT INTO transcript_retention(thread_id, through_seq) VALUES (?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq)`)
          .run(threadId, through)
    }
    if (removed >= limit) more = true

    const retained = database.query("SELECT seq FROM ui_event_log ORDER BY seq DESC LIMIT 1 OFFSET ?").get(events) as {
      seq: number
    } | null
    const agedEvents = database
      .query(`SELECT seq FROM ui_event_log INDEXED BY ui_event_log_age
        WHERE at < ? ORDER BY at, seq LIMIT ?`)
      .all(now - maxAgeMs, limit) as { seq: number }[]
    const eventCutoff = agedEvents.reduce((maximum, row) => Math.max(maximum, row.seq), retained?.seq ?? 0)
    if (eventCutoff) {
      const rows = database
        .query("SELECT seq FROM ui_event_log WHERE seq <= ? ORDER BY seq LIMIT ?")
        .all(eventCutoff, limit) as { seq: number }[]
      let through = 0
      const eventStarted = performance.now()
      database.query("UPDATE transcript_maintenance SET ui_delete_before_seq = ? WHERE id = 1").run(eventCutoff)
      for (const row of rows) {
        if (through && performance.now() - eventStarted >= 8) {
          more = true
          break
        }
        database.query("DELETE FROM ui_event_log WHERE seq = ?").run(row.seq)
        through = row.seq
      }
      if (through)
        database
          .query("UPDATE schema_meta SET value = MAX(CAST(value AS INTEGER), ?) WHERE key = 'ui_event_floor_seq'")
          .run(through)
      if (rows.length >= limit) more = true
    }
    database.exec("UPDATE transcript_maintenance SET delete_before_id = 0, ui_delete_before_seq = 0 WHERE id = 1")
    if (!more)
      database
        .query("UPDATE transcript_retention_cursor SET cursor=? WHERE id=1")
        .run(threads.length === threadLimit ? (threads.at(-1)?.cursor ?? cursor) : 0)
    return more || threads.length === threadLimit
  })()
}
