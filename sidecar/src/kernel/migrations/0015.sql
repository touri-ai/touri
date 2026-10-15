-- Automatic continuation of turns interrupted by a restart, a provider crash or a VM stop.
-- run_resume_points keeps the provider session a turn was using, recorded as soon as the
-- provider reports it, so a first turn without a saved provider session can still resume.
-- run_continuations links each automatic continuation to the turn it continues.
CREATE TABLE IF NOT EXISTS run_resume_points (
  run_id              TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  external_session_id TEXT NOT NULL,
  rollout_path        TEXT,
  fingerprint         TEXT NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_continuations (
  run_id          TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  original_run_id TEXT NOT NULL,
  previous_run_id TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('app_restart', 'provider_crash')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_continuations_original ON run_continuations(original_run_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '15');
