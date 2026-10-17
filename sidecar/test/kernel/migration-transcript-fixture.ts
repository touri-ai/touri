import type { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { hydrateHistoryEvent } from "../../src/kernel/history-backfill"

export const REPLACED_TRANSCRIPT_TRIGGERS = new Set(["messages_transcript_insert", "messages_transcript_update"])

// Historical journal bodies stay byte-for-byte intact. New revisions store small
// references whose hydration returns the latest committed message projection.
export const assertLiveTranscriptReferences = (
  database: Database,
  threadId: string,
  messageId = "fixture-live",
  expectedBeforeSeq?: number,
): void => {
  const before = database.query("SELECT updated_seq FROM threads WHERE id = ?").get(threadId) as {
    updated_seq: number
  }
  if (expectedBeforeSeq !== undefined) expect(before.updated_seq).toBe(expectedBeforeSeq)
  database
    .query(`INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at)
      VALUES (?,?,'assistant','text','After upgrade',3,3)`)
    .run(messageId, threadId)
  database.query("UPDATE messages SET text = 'Edited' WHERE thread_id = ? AND id = ?").run(threadId, messageId)
  expect(
    database.query("SELECT seq, updated_seq FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId),
  ).toEqual({
    seq: before.updated_seq + 1,
    updated_seq: before.updated_seq + 2,
  })
  const entries = database
    .query("SELECT seq, event_json FROM transcript_entries WHERE thread_id = ? AND seq > ? ORDER BY seq")
    .all(threadId, before.updated_seq) as Array<{ seq: number; event_json: string }>
  expect(entries).toHaveLength(2)
  for (const [index, entry] of entries.entries()) {
    const type = index === 0 ? "message.created" : "message.updated"
    expect(JSON.parse(entry.event_json)).toEqual({
      type,
      ref: true,
      threadId,
      messageId,
      seq: before.updated_seq + index + 1,
    })
    expect(hydrateHistoryEvent(database, entry.event_json)).toMatchObject({
      type,
      message: { id: messageId, threadId, text: "Edited", updatedSeq: before.updated_seq + 2 },
    })
  }
  expect(database.query("SELECT through_seq FROM transcript_retention WHERE thread_id = ?").get(threadId)).toEqual({
    through_seq: before.updated_seq + 1,
  })
}
