CREATE TABLE browser_pending_handoffs (
  tab_id TEXT PRIMARY KEY REFERENCES browser_tabs(id) ON DELETE CASCADE,
  bot_id TEXT,
  thread_id TEXT,
  run_id TEXT,
  request_id TEXT,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','returned'))
);
INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('browser_pending_handoffs_version','1');
UPDATE schema_meta SET value='43' WHERE key='schema_version';
