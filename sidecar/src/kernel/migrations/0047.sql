CREATE TABLE IF NOT EXISTS automatic_resume_jobs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  original_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('app_restart', 'provider_crash')),
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'started', 'abandoned'))
);
CREATE INDEX IF NOT EXISTS automatic_resume_original ON automatic_resume_jobs(original_run_id);
CREATE INDEX IF NOT EXISTS automatic_resume_pending ON automatic_resume_jobs(state, run_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('automatic_resume_version', '1');
UPDATE schema_meta SET value = '47' WHERE key = 'schema_version';
