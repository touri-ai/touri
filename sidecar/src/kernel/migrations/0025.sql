-- One durable checkpoint per conversation; completed goals remain until explicitly replaced.
CREATE TABLE IF NOT EXISTS goals (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  run_id TEXT,
  checkpoint_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_run_id ON goals(run_id);
UPDATE schema_meta SET value = '25' WHERE key = 'schema_version';
