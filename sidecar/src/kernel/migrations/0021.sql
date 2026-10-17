-- Recovery can seek both text appends and compact part patches without scanning snapshots.
CREATE INDEX IF NOT EXISTS transcript_stream_message
  ON transcript_entries(thread_id, json_extract(event_json, '$.messageId'), seq)
  WHERE json_extract(event_json, '$.type') IN ('message.delta', 'message.parts');
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('stream_writer_version', '1');
UPDATE schema_meta SET value = '21' WHERE key = 'schema_version';
