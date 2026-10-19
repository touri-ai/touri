import type { Database } from "bun:sqlite"

export const DELETE_MESSAGE_SEARCH_SQL = `DELETE FROM messages_fts WHERE rowid IN (
  SELECT fts_rowid FROM message_search_rows WHERE thread_id = ? AND message_id = ?
) AND thread_id = ? AND message_id = ?`

export const refreshMessageSearch = (
  database: Database,
  message: { threadId: string; id: string; text: string },
  { indexEmpty = true }: { indexEmpty?: boolean } = {},
): void => {
  database
    .transaction(() => {
      database.query(DELETE_MESSAGE_SEARCH_SQL).run(message.threadId, message.id, message.threadId, message.id)
      database
        .query("DELETE FROM message_search_rows WHERE thread_id = ? AND message_id = ?")
        .run(message.threadId, message.id)
      if (!message.text && !indexEmpty) return

      const inserted = database
        .query("INSERT INTO messages_fts(text, thread_id, message_id) VALUES (?, ?, ?)")
        .run(message.text, message.threadId, message.id)
      database
        .query("INSERT INTO message_search_rows(thread_id, message_id, fts_rowid) VALUES (?, ?, ?)")
        .run(message.threadId, message.id, inserted.lastInsertRowid)
    })
    .immediate()
}
