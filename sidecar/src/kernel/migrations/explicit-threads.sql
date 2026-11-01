ALTER TABLE threads ADD COLUMN anchor_message_id TEXT;
CREATE UNIQUE INDEX threads_anchor_message ON threads(parent_thread_id, anchor_message_id) WHERE anchor_message_id IS NOT NULL;
UPDATE routines SET continuity = 'main-thread', results_thread_id = NULL WHERE continuity = 'new-thread';
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('explicit_threads_version', '1');
ALTER TABLE threads ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER thread_reply_insert AFTER INSERT ON messages
WHEN NEW.parent_id IS NOT NULL AND NEW.role IN ('user','assistant')
BEGIN
  UPDATE threads SET reply_count = reply_count + 1 WHERE id = NEW.thread_id AND anchor_message_id IS NOT NULL;
END;
CREATE TRIGGER thread_reply_delete AFTER DELETE ON messages
WHEN OLD.parent_id IS NOT NULL AND OLD.role IN ('user','assistant')
BEGIN
  UPDATE threads SET reply_count = MAX(0, reply_count - 1) WHERE id = OLD.thread_id AND anchor_message_id IS NOT NULL;
END;
