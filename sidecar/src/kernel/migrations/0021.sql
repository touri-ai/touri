-- Sidebar reads seek a handful of rows per thread instead of walking message/run history.
-- Ascending timestamps permit reverse index scans with the implicit rowid tie breaker.
CREATE INDEX IF NOT EXISTS bots_live_order ON bots(sort_order, created_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_visible_created ON messages(thread_id, created_at)
  WHERE trim(text) <> '' OR status IN ('failed', 'canceled')
    OR parts_json LIKE '%"type":"approval"%' OR parts_json LIKE '%"type":"notice"%';
CREATE INDEX IF NOT EXISTS messages_assistant_created ON messages(thread_id, created_at) WHERE role = 'assistant';
CREATE INDEX IF NOT EXISTS messages_assistant_updated ON messages(thread_id, updated_at) WHERE role = 'assistant';
CREATE INDEX IF NOT EXISTS messages_assistant_settled ON messages(thread_id, updated_at)
  WHERE role = 'assistant' AND status <> 'streaming';
CREATE INDEX IF NOT EXISTS messages_assistant_complete ON messages(thread_id, updated_at)
  WHERE role = 'assistant' AND status = 'complete';
CREATE INDEX IF NOT EXISTS threads_workspace ON threads(bot_id)
  WHERE archived_at IS NULL AND group_thread_id IS NULL;
CREATE INDEX IF NOT EXISTS runs_active_workspace ON runs(status, thread_id)
  WHERE status IN ('queued', 'starting', 'running');
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(kind, created_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_pending_request ON notifications(request_id, thread_id)
  WHERE resolved_at IS NULL AND request_id IS NOT NULL;

-- Compact attention parts let old approvals remain visible and render latest
-- previews without parsing historical tool-output bodies on each workspace read.
CREATE TABLE IF NOT EXISTS workspace_message_attention (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('approval', 'notice')),
  approval_id TEXT,
  decision TEXT,
  part_json TEXT NOT NULL,
  PRIMARY KEY(thread_id, message_id, part_index),
  FOREIGN KEY(thread_id, message_id) REFERENCES messages(thread_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_attention_pending ON workspace_message_attention(thread_id, message_id)
  WHERE type = 'approval' AND decision = 'pending';
CREATE INDEX IF NOT EXISTS workspace_attention_request ON workspace_message_attention(approval_id, thread_id, message_id)
  WHERE type = 'approval';
CREATE TABLE IF NOT EXISTS workspace_attention_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL
);
INSERT OR IGNORE INTO workspace_attention_backfill(id, cursor)
  SELECT 1, MAX(rowid) FROM messages
  WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = 'workspace_activity_version')
  HAVING MAX(rowid) IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS workspace_attention_insert AFTER INSERT ON messages
WHEN instr(NEW.parts_json, '"approval"') > 0 OR instr(NEW.parts_json, '"notice"') > 0 BEGIN
  INSERT OR REPLACE INTO workspace_message_attention
    SELECT NEW.thread_id, NEW.id, CAST(p.key AS INTEGER), json_extract(p.value, '$.type'),
      json_extract(p.value, '$.approvalId'), json_extract(p.value, '$.decision'), p.value
    FROM json_each(NEW.parts_json) p WHERE json_extract(p.value, '$.type') IN ('approval', 'notice');
END;
CREATE TRIGGER IF NOT EXISTS workspace_attention_update AFTER UPDATE OF parts_json ON messages
WHEN NEW.parts_json <> OLD.parts_json AND (instr(NEW.parts_json, '"approval"') > 0
  OR instr(NEW.parts_json, '"notice"') > 0 OR EXISTS (
    SELECT 1 FROM workspace_message_attention WHERE thread_id = OLD.thread_id AND message_id = OLD.id
  )) BEGIN
  DELETE FROM workspace_message_attention WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
  INSERT OR REPLACE INTO workspace_message_attention
    SELECT NEW.thread_id, NEW.id, CAST(p.key AS INTEGER), json_extract(p.value, '$.type'),
      json_extract(p.value, '$.approvalId'), json_extract(p.value, '$.decision'), p.value
    FROM json_each(NEW.parts_json) p WHERE json_extract(p.value, '$.type') IN ('approval', 'notice');
END;
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('workspace_activity_version', '1');
UPDATE schema_meta SET value = '21' WHERE key = 'schema_version';
