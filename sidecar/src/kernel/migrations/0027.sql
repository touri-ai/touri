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
DROP TRIGGER IF EXISTS message_search_delete;
CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid IN (
    SELECT fts_rowid FROM message_search_rows WHERE thread_id = OLD.thread_id AND message_id = OLD.id
  ) AND thread_id = OLD.thread_id AND message_id = OLD.id;
  DELETE FROM message_search_rows WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
END;
CREATE INDEX IF NOT EXISTS tool_resolutions_thread_resolution ON tool_resolutions(thread_id, resolution, run_id);

-- Recovery is incremental even when history is imported while the server runs.
-- Ordinary terminal transitions clear their own marker in the same transaction.
CREATE TABLE IF NOT EXISTS tool_recovery_pending (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_recovery_thread ON tool_recovery_pending(thread_id, run_id);
INSERT OR IGNORE INTO tool_recovery_pending(run_id, thread_id)
  SELECT id, thread_id FROM runs WHERE status IN ('succeeded','failed','canceled','interrupted');
CREATE TRIGGER IF NOT EXISTS tool_recovery_run_insert AFTER INSERT ON runs
WHEN NEW.status IN ('succeeded','failed','canceled','interrupted') BEGIN
  INSERT OR REPLACE INTO tool_recovery_pending VALUES (NEW.id, NEW.thread_id);
END;
CREATE TRIGGER IF NOT EXISTS tool_recovery_run_update AFTER UPDATE OF status, reply_message_id ON runs
WHEN NEW.status IN ('succeeded','failed','canceled','interrupted')
  AND (NEW.status IS NOT OLD.status OR NEW.reply_message_id IS NOT OLD.reply_message_id) BEGIN
  INSERT OR REPLACE INTO tool_recovery_pending VALUES (NEW.id, NEW.thread_id);
END;
CREATE TRIGGER IF NOT EXISTS tool_recovery_message_insert AFTER INSERT ON messages
WHEN EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND status IN ('succeeded','failed','canceled','interrupted')) BEGIN
  INSERT OR REPLACE INTO tool_recovery_pending VALUES (NEW.run_id, NEW.thread_id);
END;
CREATE TRIGGER IF NOT EXISTS tool_recovery_message_update AFTER UPDATE OF parts_json, status, run_id ON messages
WHEN (NEW.parts_json IS NOT OLD.parts_json OR NEW.status IS NOT OLD.status OR NEW.run_id IS NOT OLD.run_id)
  AND EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND status IN ('succeeded','failed','canceled','interrupted')) BEGIN
  INSERT OR REPLACE INTO tool_recovery_pending VALUES (NEW.run_id, NEW.thread_id);
END;
CREATE TRIGGER IF NOT EXISTS tool_recovery_result_insert AFTER INSERT ON tool_resolutions
WHEN EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND status IN ('succeeded','failed','canceled','interrupted')) BEGIN
  INSERT OR REPLACE INTO tool_recovery_pending VALUES (NEW.run_id, NEW.thread_id);
END;
CREATE TRIGGER IF NOT EXISTS tool_recovery_result_update AFTER UPDATE OF part_json, resolution, resolved_at ON tool_resolutions
WHEN (NEW.part_json IS NOT OLD.part_json OR NEW.resolution IS NOT OLD.resolution OR NEW.resolved_at IS NOT OLD.resolved_at)
  AND EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND status IN ('succeeded','failed','canceled','interrupted')) BEGIN
  INSERT OR REPLACE INTO tool_recovery_pending VALUES (NEW.run_id, NEW.thread_id);
END;
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('message_search_rows_version', '2');
UPDATE schema_meta SET value = '27' WHERE key = 'schema_version';
