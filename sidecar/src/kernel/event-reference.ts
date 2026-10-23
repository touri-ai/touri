import type { Database } from "bun:sqlite"
import type { UiEvent } from "@touri/contracts"
import type { TranscriptRef } from "./transcript-events"

export const getRefEvent = (database: Database, event: TranscriptRef): UiEvent => {
  const entry = database
    .query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
    .get(event.threadId, event.seq) as { event_json: string } | null
  const revision = entry ? (JSON.parse(entry.event_json) as UiEvent | TranscriptRef) : null
  if (
    !isMessageRef(revision) &&
    (revision?.type === "message.created" || revision?.type === "message.updated") &&
    revision.message.id === event.messageId
  )
    return revision
  if (event.type === "message.delta" || event.type === "message.parts") {
    if (
      !isMessageRef(revision) &&
      (revision?.type === "message.delta" || revision?.type === "message.parts") &&
      revision.messageId === event.messageId
    )
      return revision
    return { type: "transcript.resync" }
  }
  // Retention removed that revision: the current projection is newer and supersedes it.
  const current = database
    .query("SELECT payload FROM transcript_message_events WHERE thread_id = ? AND id = ?")
    .get(event.threadId, event.messageId) as { payload: string } | null
  return current ? ({ type: event.type, ...JSON.parse(current.payload) } as UiEvent) : { type: "transcript.superseded" }
}

export const isMessageRef = (value: unknown): value is TranscriptRef =>
  typeof value === "object" && value !== null && (value as { ref?: unknown }).ref === true
