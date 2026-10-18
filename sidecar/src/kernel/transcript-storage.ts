import type { Database } from "bun:sqlite"
import type { MessagePart, UiEvent } from "@touri/contracts"

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

// Snapshots are mutable projections. The small, durable entries remain the source of
// uncheckpointed text, including after a crash. Publishing a projection adds no event.
export const materializeTranscript = (database: Database): void => {
  if (!database.query("SELECT 1 FROM transcript_pending_deltas LIMIT 1").get()) return
  database.transaction(() => {
    const rows = database
      .query(
        // Drive both indexed stream lookups from the small dirty-message queue.
        `SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_pending_deltas p
         CROSS JOIN messages m
         CROSS JOIN transcript_entries e INDEXED BY transcript_delta_message
         WHERE m.thread_id = p.thread_id AND m.id = p.message_id
           AND e.thread_id = p.thread_id AND json_extract(e.event_json, '$.messageId') = p.message_id
           AND json_extract(e.event_json, '$.type') = 'message.delta' AND e.seq > m.updated_seq
         UNION ALL
         SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_pending_deltas p
         CROSS JOIN messages m
         CROSS JOIN transcript_part_entries part INDEXED BY transcript_part_message
         CROSS JOIN transcript_entries e
         WHERE m.thread_id = p.thread_id AND m.id = p.message_id
           AND part.thread_id = p.thread_id AND part.message_id = p.message_id
           AND e.id = part.entry_id AND e.seq > m.updated_seq
         ORDER BY entry_id`,
      )
      .all() as Array<{ id: string; thread_id: string; delta_seq: number; at: number; event_json: string }>
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
      database.exec("DELETE FROM transcript_pending_deltas")
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
      database
        .query("DELETE FROM messages_fts WHERE thread_id = ? AND message_id = ?")
        .run(projection.thread_id, projection.id)
      database
        .query("INSERT INTO messages_fts(text, thread_id, message_id) VALUES (?, ?, ?)")
        .run(projection.text, projection.thread_id, projection.id)
    }
    database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1")
    database.exec("DELETE FROM transcript_pending_deltas")
  })()
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
    const threads = database.query("SELECT id FROM threads WHERE updated_seq > ?").all(entriesPerThread) as {
      id: string
    }[]
    for (const thread of threads) {
      // A bounded reverse seek replaces ranking every retained historical row.
      const excess = database
        .query(`SELECT seq, id FROM transcript_entries
          WHERE thread_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`)
        .get(thread.id, entriesPerThread) as { seq: number; id: number } | null
      if (excess && excess.id <= checkpoint) cutoffs.set(thread.id, Math.max(cutoffs.get(thread.id) ?? 0, excess.seq))
    }
    if (cutoffs.size) materializeTranscript(database)
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
    return more
  })()
}
