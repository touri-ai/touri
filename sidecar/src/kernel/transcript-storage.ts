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
  database.transaction(() => {
    const rows = database
      .query(
        // ORDER BY e.id otherwise makes SQLite scan and parse every historical message body.
        `SELECT e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_entries e INDEXED BY transcript_stream_message
         JOIN messages m ON m.thread_id = e.thread_id AND m.id = json_extract(e.event_json, '$.messageId')
         WHERE json_extract(e.event_json, '$.type') IN ('message.delta', 'message.parts') AND e.seq > m.updated_seq
         ORDER BY e.id`,
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
    if (!projections.size) return
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
  const rows = botReplayRows(database, botId)
  const floor = rows.reduce((maximum, row) => Math.max(maximum, row.seq), 0)
  if (!floor) return
  database.query("UPDATE transcript_maintenance SET ui_delete_before_seq=? WHERE id=1").run(floor)
  for (const row of rows) database.query("DELETE FROM ui_event_log WHERE seq=?").run(row.seq)
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
}): void => {
  database.transaction(() => {
    const checkpoint = Number(
      (
        database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
          value: string
        }
      ).value,
    )
    // Only compact published entries. Recovery must still see an unpublished tail.
    const cutoffs = database
      .query(
        `WITH ranked AS (
          SELECT id, thread_id, seq, at, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY seq DESC) AS n
          FROM transcript_entries
        ) SELECT thread_id, MAX(seq) AS seq, MAX(id) AS id FROM ranked
          WHERE id <= ? AND (n > ? OR at < ?) GROUP BY thread_id`,
      )
      .all(checkpoint, entriesPerThread, now - maxAgeMs) as Array<{ thread_id: string; seq: number; id: number }>
    if (cutoffs.length) materializeTranscript(database)
    for (const cutoff of cutoffs) {
      database.query("UPDATE transcript_maintenance SET delete_before_id = ? WHERE id = 1").run(cutoff.id)
      database
        .query("DELETE FROM transcript_entries WHERE thread_id = ? AND seq <= ?")
        .run(cutoff.thread_id, cutoff.seq)
      database.query("DELETE FROM rejections WHERE thread_id = ? AND seq <= ?").run(cutoff.thread_id, cutoff.seq)
      database
        .query(
          `INSERT INTO transcript_retention(thread_id, through_seq) VALUES (?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq)`,
        )
        .run(cutoff.thread_id, cutoff.seq)
    }
    const eventCutoff = database
      .query(
        `SELECT MAX(seq) AS seq FROM ui_event_log WHERE seq <= COALESCE(
          (SELECT seq FROM ui_event_log ORDER BY seq DESC LIMIT 1 OFFSET ?), 0) OR at < ?`,
      )
      .get(events, now - maxAgeMs) as { seq: number | null }
    if (eventCutoff.seq !== null) {
      database.query("UPDATE transcript_maintenance SET ui_delete_before_seq = ? WHERE id = 1").run(eventCutoff.seq)
      database.query("DELETE FROM ui_event_log WHERE seq <= ?").run(eventCutoff.seq)
      database.query("UPDATE schema_meta SET value = ? WHERE key = 'ui_event_floor_seq'").run(String(eventCutoff.seq))
    }
    database.exec("UPDATE transcript_maintenance SET delete_before_id = 0, ui_delete_before_seq = 0 WHERE id = 1")
  })()
}
