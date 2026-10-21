-- Keep browser handbacks separate so startup does not rebuild continuation history.
CREATE TABLE IF NOT EXISTS browser_takeover_continuations (
  run_id          TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  original_run_id TEXT NOT NULL,
  previous_run_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_takeover_continuations_original
  ON browser_takeover_continuations(original_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS browser_takeover_continuations_previous
  ON browser_takeover_continuations(previous_run_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('browser_takeover_continuations_version', '1');
UPDATE schema_meta SET value = '38' WHERE key = 'schema_version';
