import type { Database } from "bun:sqlite"
import type { Kernel, Thread, TranscriptAppend, TranscriptRejection } from "@touri/contracts"

export const MAX_TRANSCRIPT_DELTA_BYTES = 256 * 1024

export const appendRejection = (
  input: TranscriptAppend,
  thread: Thread | null,
): TranscriptRejection["reason"] | null => {
  if (
    typeof input.delta !== "string" ||
    !input.delta ||
    !Number.isSafeInteger(input.partIndex) ||
    input.partIndex < 0 ||
    (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 1)) ||
    (input.expectedSeq !== undefined && (!Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0))
  )
    return "validation"
  if (Buffer.byteLength(input.delta, "utf8") > MAX_TRANSCRIPT_DELTA_BYTES) return "oversize"
  if (input.generation !== undefined && input.generation !== thread?.generation) return "stale_generation"
  return null
}

// Persist only routing and conflict metadata; a rejected payload may contain sensitive text.
export const recordTranscriptRejection = (
  kernel: Kernel,
  input: TranscriptAppend,
  reason: TranscriptRejection["reason"],
): void => {
  const database = kernel.db as Database
  const rejection = database
    .transaction(() => {
      const thread = database.query("SELECT generation, updated_seq FROM threads WHERE id = ?").get(input.threadId) as {
        generation: number
        updated_seq: number
      } | null
      const previousSeq = Math.max(
        thread?.updated_seq ?? 0,
        (
          database
            .query("SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript_entries WHERE thread_id = ?")
            .get(input.threadId) as { seq: number }
        ).seq,
      )
      const record: TranscriptRejection = {
        threadId: input.threadId,
        messageId: input.messageId,
        partIndex: Number.isSafeInteger(input.partIndex) ? input.partIndex : null,
        reason,
        seq: previousSeq + 1,
        generation: thread?.generation ?? 1,
        expectedGeneration: Number.isSafeInteger(input.generation) ? (input.generation ?? null) : null,
        expectedSeq: Number.isSafeInteger(input.expectedSeq) ? (input.expectedSeq ?? null) : null,
        at: Date.now(),
      }
      database
        .query("INSERT INTO rejections(thread_id, seq, generation, record_json, at) VALUES (?, ?, ?, ?, ?)")
        .run(record.threadId, record.seq, record.generation, JSON.stringify(record), record.at)
      database.query("UPDATE threads SET updated_seq = ? WHERE id = ?").run(record.seq, record.threadId)
      database
        .query("INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES (?, ?, ?, ?, ?)")
        .run(
          record.threadId,
          record.seq,
          record.generation,
          JSON.stringify({ type: "transcript.rejected", rejection: record }),
          record.at,
        )
      return record
    })
    .immediate()
  kernel.publish({ type: "transcript.rejected", rejection })
}
