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
  database.transaction(() => {
    const checkpoint = Number(
      (
        database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
          value: string
        }
      ).value,
    )
    const rows = database
      .query("SELECT id, at, event_json FROM transcript_entries WHERE id > ? ORDER BY id")
      .all(checkpoint) as Array<{ id: number; at: number; event_json: string }>
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as UiEvent & { legacy?: boolean }
      if (event.legacy) continue
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
    const last = rows.at(-1)
    if (last)
      database.query("UPDATE schema_meta SET value = ? WHERE key = 'transcript_event_checkpoint'").run(String(last.id))
  })()
}
