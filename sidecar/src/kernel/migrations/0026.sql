-- FTS cannot index its UNINDEXED identity columns. Preserve existing rowids and
-- build only their small lookup keys; do not rebuild or tokenize message text.
CREATE TABLE IF NOT EXISTS message_search_rows (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  fts_rowid INTEGER NOT NULL,
  PRIMARY KEY(thread_id, message_id, fts_rowid)
);
INSERT OR IGNORE INTO message_search_rows(thread_id, message_id, fts_rowid)
  SELECT thread_id, message_id, rowid FROM messages_fts;
CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid IN (
    SELECT fts_rowid FROM message_search_rows WHERE thread_id = OLD.thread_id AND message_id = OLD.id
  );
  DELETE FROM message_search_rows WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
END;
CREATE INDEX IF NOT EXISTS tool_resolutions_thread_resolution ON tool_resolutions(thread_id, resolution, run_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('message_search_rows_version', '1');
UPDATE schema_meta SET value = '26' WHERE key = 'schema_version';
