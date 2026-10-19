import type { Database } from "bun:sqlite"
import type { UiEvent } from "@touri/contracts"

export type TranscriptRef = {
  type: "message.created" | "message.updated" | "message.delta" | "message.parts"
  ref: true
  threadId: string
  messageId: string
  seq: number
}

/** Capture inside the writer transaction: the journal owns each body exactly once. */
export const captureTranscript = (database: Database): void => {
  const checkpointRow = database
    .query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'")
    .get() as { value: string } | null
  const checkpoint = Number(checkpointRow?.value ?? 0)
  if (!database.query("SELECT 1 FROM transcript_entries WHERE id > ? LIMIT 1").get(checkpoint)) return

  database
    .transaction(() => {
      const checkpoint = Number(
        (
          database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
            value: string
          }
        ).value,
      )
      const statement = database.prepare("SELECT id, at, event_json FROM transcript_entries WHERE id > ? ORDER BY id")
      let last = checkpoint
      try {
        const rows = statement.iterate(checkpoint) as Iterable<{ id: number; at: number; event_json: string }>
        for (const row of rows) {
          last = row.id
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
    })
    .immediate()
}
