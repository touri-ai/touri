-- Start empty: upgrading must not parse historical transcript snapshots to build
-- a JSON index. The canonical event owns the body; this is only its recovery key.
CREATE TABLE IF NOT EXISTS transcript_part_entries (
  entry_id INTEGER PRIMARY KEY REFERENCES transcript_entries(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transcript_part_message ON transcript_part_entries(thread_id, message_id, entry_id);
INSERT OR IGNORE INTO transcript_pending_deltas(thread_id, message_id)
  SELECT p.thread_id, p.message_id FROM transcript_part_entries p
  JOIN transcript_entries e ON e.id = p.entry_id
  JOIN messages m ON m.thread_id = p.thread_id AND m.id = p.message_id
  WHERE e.seq > m.updated_seq;

-- Compact part patches are dirty projections too. Keep sidebar approval/notice
-- state current in the same transaction, without checkpointing the message body.
CREATE TRIGGER IF NOT EXISTS transcript_pending_parts_insert AFTER INSERT ON transcript_entries
WHEN json_extract(NEW.event_json, '$.type') = 'message.parts'
BEGIN
  INSERT OR IGNORE INTO transcript_pending_deltas(thread_id, message_id)
    VALUES (NEW.thread_id, json_extract(NEW.event_json, '$.messageId'));
  DELETE FROM workspace_message_attention
    WHERE thread_id = NEW.thread_id AND message_id = json_extract(NEW.event_json, '$.messageId')
      AND part_index IN (SELECT json_extract(value, '$.partIndex') FROM json_each(NEW.event_json, '$.parts'));
  INSERT OR REPLACE INTO workspace_message_attention(thread_id, message_id, part_index, type, approval_id, decision, part_json)
    SELECT NEW.thread_id, json_extract(NEW.event_json, '$.messageId'), json_extract(p.value, '$.partIndex'),
      json_extract(p.value, '$.part.type'), json_extract(p.value, '$.part.approvalId'),
      json_extract(p.value, '$.part.decision'), json_extract(p.value, '$.part')
    FROM json_each(NEW.event_json, '$.parts') p
    WHERE json_extract(p.value, '$.part.type') IN ('approval', 'notice');
END;

INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('stream_writer_version', '2');
UPDATE schema_meta SET value = '23' WHERE key = 'schema_version';
