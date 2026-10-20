CREATE TABLE IF NOT EXISTS workspace_attention_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('workspace_attention_backfill_version', '1');
UPDATE schema_meta SET value = '36' WHERE key = 'schema_version';
