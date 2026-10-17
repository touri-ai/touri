-- Message projections and their locator commit together. Keep one complete body
-- in messages instead of copying a growing tool transcript on every item update.
DROP TRIGGER messages_transcript_insert;
DROP TRIGGER messages_transcript_update;

CREATE TRIGGER messages_transcript_insert AFTER INSERT ON messages BEGIN
  UPDATE threads SET updated_seq = updated_seq + 1 WHERE id = NEW.thread_id;
  UPDATE messages SET seq = (SELECT updated_seq FROM threads WHERE id = NEW.thread_id),
    updated_seq = (SELECT updated_seq FROM threads WHERE id = NEW.thread_id),
    generation = (SELECT generation FROM threads WHERE id = NEW.thread_id)
    WHERE thread_id = NEW.thread_id AND id = NEW.id;
  INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)
    SELECT thread_id, updated_seq, generation,
      json_object('type', 'message.created', 'ref', json('true'),
        'threadId', thread_id, 'messageId', id, 'seq', updated_seq), updated_at
    FROM messages WHERE thread_id = NEW.thread_id AND id = NEW.id;
END;

CREATE TRIGGER messages_transcript_update
AFTER UPDATE OF parent_id, role, kind, status, run_id, text, parts_json, sender_json, source, client_nonce, delivery_status, delivery_deadline ON messages
WHEN (SELECT projection_write FROM transcript_maintenance WHERE id = 1) = 0
  AND (NEW.parent_id IS NOT OLD.parent_id OR NEW.role IS NOT OLD.role
    OR NEW.kind IS NOT OLD.kind OR NEW.status IS NOT OLD.status
    OR NEW.run_id IS NOT OLD.run_id OR NEW.text IS NOT OLD.text
    OR NEW.parts_json IS NOT OLD.parts_json OR NEW.sender_json IS NOT OLD.sender_json
    OR NEW.source IS NOT OLD.source OR NEW.client_nonce IS NOT OLD.client_nonce
    OR NEW.delivery_status IS NOT OLD.delivery_status OR NEW.delivery_deadline IS NOT OLD.delivery_deadline)
BEGIN
  UPDATE threads SET updated_seq = updated_seq + 1 WHERE id = NEW.thread_id;
  UPDATE messages SET updated_seq = (SELECT updated_seq FROM threads WHERE id = NEW.thread_id),
    generation = (SELECT generation FROM threads WHERE id = NEW.thread_id)
    WHERE thread_id = NEW.thread_id AND id = NEW.id;
  INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)
    SELECT thread_id, updated_seq, generation,
      json_object('type', 'message.updated', 'ref', json('true'),
        'threadId', thread_id, 'messageId', id, 'seq', updated_seq), updated_at
    FROM messages WHERE thread_id = NEW.thread_id AND id = NEW.id;
END;

-- A cursor that needs an overwritten snapshot must reload the complete current
-- projection. This also covers text checkpoints, without losing pending deltas.
CREATE TRIGGER messages_transcript_pointer_superseded AFTER UPDATE OF updated_seq ON messages
WHEN NEW.updated_seq > OLD.updated_seq AND OLD.updated_seq > 0
BEGIN
  INSERT INTO transcript_retention(thread_id, through_seq) VALUES (NEW.thread_id, OLD.updated_seq)
    ON CONFLICT(thread_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq);
END;

-- Recover only dirty projections on reads/restart, not every historical delta.
CREATE TABLE transcript_pending_deltas (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY(thread_id, message_id)
);
INSERT INTO transcript_pending_deltas(thread_id, message_id)
  SELECT DISTINCT e.thread_id, json_extract(e.event_json, '$.messageId')
  FROM transcript_entries e INDEXED BY transcript_delta_message
  JOIN messages m ON m.thread_id = e.thread_id AND m.id = json_extract(e.event_json, '$.messageId')
  WHERE json_extract(e.event_json, '$.type') = 'message.delta' AND e.seq > m.updated_seq;
CREATE TRIGGER transcript_pending_delta_insert AFTER INSERT ON transcript_entries
WHEN json_extract(NEW.event_json, '$.type') = 'message.delta'
BEGIN
  INSERT OR IGNORE INTO transcript_pending_deltas(thread_id, message_id)
    VALUES (NEW.thread_id, json_extract(NEW.event_json, '$.messageId'));
END;
CREATE TRIGGER transcript_pending_message_delete AFTER DELETE ON messages BEGIN
  DELETE FROM transcript_pending_deltas WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
END;

CREATE INDEX transcript_entries_age ON transcript_entries(at, id);
CREATE INDEX ui_event_log_age ON ui_event_log(at, seq);

CREATE TABLE storage_backup_attachments (attachment_id TEXT PRIMARY KEY);

-- Backup and resumable pruning run after listen. Automatic retention waits for
-- the marker so it cannot remove any historical payload before the backup.
INSERT INTO schema_meta(key, value)
  SELECT 'storage_upgrade_22', 'pending'
  WHERE EXISTS (SELECT 1 FROM transcript_entries) OR EXISTS (SELECT 1 FROM messages);
INSERT INTO settings(key, value_json, updated_at)
  SELECT 'storage.upgrade.22', json_object('cursor', 0, 'total', COALESCE(MAX(id), 0), 'backup', json('false')), 0
  FROM transcript_entries
  HAVING MAX(id) IS NOT NULL OR EXISTS (SELECT 1 FROM messages);

INSERT INTO schema_meta(key, value) VALUES ('transcript_projection_references_version', '1');
UPDATE schema_meta SET value = '22' WHERE key = 'schema_version';
