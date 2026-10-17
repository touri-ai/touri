-- Approved access can require a fresh provider session even when the previous turn succeeded.
CREATE TABLE run_continuations_next (
  run_id          TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  original_run_id TEXT NOT NULL,
  previous_run_id TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('app_restart', 'provider_crash', 'permission_granted')),
  created_at      INTEGER NOT NULL
);
INSERT INTO run_continuations_next SELECT * FROM run_continuations;
DROP TABLE run_continuations;
ALTER TABLE run_continuations_next RENAME TO run_continuations;
CREATE INDEX run_continuations_original ON run_continuations(original_run_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('permission_continuations_version', '1');
