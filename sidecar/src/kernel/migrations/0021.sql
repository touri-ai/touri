-- Start empty: upgrading must not parse historical transcript snapshots to build
-- a JSON index. The canonical event owns the body; this is only its recovery key.
CREATE TABLE IF NOT EXISTS transcript_part_entries (
  entry_id INTEGER PRIMARY KEY REFERENCES transcript_entries(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_part_message ON transcript_part_entries(thread_id, message_id, entry_id);
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('stream_writer_version', '1');
UPDATE schema_meta SET value = '21' WHERE key = 'schema_version';
