CREATE TABLE bot_deletions (
  bot_id TEXT PRIMARY KEY,
  delete_volumes INTEGER NOT NULL CHECK (delete_volumes IN (0, 1)),
  phase TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  high_water INTEGER NOT NULL DEFAULT 0,
  attachment_page INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  file_cursor TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE bot_deletion_attachments (
  bot_id TEXT NOT NULL REFERENCES bot_deletions(bot_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (bot_id, attachment_id)
);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('bot_deletion_version', '1');
UPDATE schema_meta SET value = '35' WHERE key = 'schema_version';
