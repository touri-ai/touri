import type { Database } from "bun:sqlite"
import type { UiEvent } from "@touri/contracts"

export type TranscriptRef = {
  type: "message.created" | "message.updated" | "message.delta" | "message.parts"
  ref: true
  threadId: string
  messageId: string
  seq: number
}

export const TRANSCRIPT_CAPTURE_LIMIT = 32

/** Each checkpoint commits with its replay rows; a backlog continues on another task. */
export const captureTranscript = (database: Database): boolean => {
  const checkpointRow = database
    .query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'")
    .get() as { value: string } | null
  const checkpoint = Number(checkpointRow?.value ?? 0)
  if (!database.query("SELECT 1 FROM transcript_entries WHERE id > ? LIMIT 1").get(checkpoint)) return false

  return database
    .transaction(() => {
      const checkpoint = Number(
        (
          database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
            value: string
          }
        ).value,
      )
      const hasDeletions = database.query("SELECT 1 FROM schema_meta WHERE key = 'bot_deletion_version'").get()
      const statement = database.prepare(
        "SELECT id, thread_id, at, event_json FROM transcript_entries WHERE id > ? ORDER BY id LIMIT ?",
      )
      const started = performance.now()
      // The local cursor advances only after a row is processed in this transaction.
      let last = checkpoint
      try {
        const rows = statement.iterate(checkpoint, TRANSCRIPT_CAPTURE_LIMIT) as Iterable<{
          id: number
          thread_id: string
          at: number
          event_json: string
        }>
        for (const row of rows) {
          if (last > checkpoint && performance.now() - started >= 8) break
          last = row.id
          // A resumed capture must not recreate replay copies after the purge's high-water mark.
          if (
            hasDeletions &&
            database
              .query(`SELECT 1 FROM threads t JOIN bot_deletions d ON d.bot_id = t.bot_id
                WHERE t.id = ? LIMIT 1`)
              .get(row.thread_id)
          )
            continue
          const event = JSON.parse(row.event_json) as (UiEvent & { legacy?: boolean }) | TranscriptRef
          if ("legacy" in event && event.legacy) continue
          if ("ref" in event) {
            database.query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)").run(row.at, row.event_json)
            continue
          }
          let stored = row.event_json
          if (event.type === "message.created" || event.type === "message.updated") {
            if (event.message.updatedSeq !== undefined)
              stored = JSON.stringify({
                type: event.type,
                ref: true,
                threadId: event.message.threadId,
                messageId: event.message.id,
                seq: event.message.updatedSeq,
              } satisfies TranscriptRef)
          } else if (event.type === "message.delta" || event.type === "message.parts") {
            stored = JSON.stringify({
              type: event.type,
              ref: true,
              threadId: event.threadId,
              messageId: event.messageId,
              seq: event.updatedSeq ?? 0,
            } satisfies TranscriptRef)
          }
          database.query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)").run(row.at, stored)
        }
      } finally {
        statement.finalize()
      }
      if (last > checkpoint)
        database.query("UPDATE schema_meta SET value = ? WHERE key = 'transcript_event_checkpoint'").run(String(last))
      return Boolean(database.query("SELECT 1 FROM transcript_entries WHERE id > ? LIMIT 1").get(last))
    })
    .immediate()
}
