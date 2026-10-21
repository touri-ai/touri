CREATE TABLE IF NOT EXISTS browser_channel_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  requester_person_id TEXT,
  responsible_person_id TEXT,
  controller_person_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','needs_you','taken_over','succeeded','failed','canceled')),
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  needs_you_at INTEGER,
  escalated_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS browser_channel_runs_queue
  ON browser_channel_runs(group_id, thread_id, bot_id, status, queued_at, run_id);
CREATE INDEX IF NOT EXISTS browser_channel_runs_thread_queue
  ON browser_channel_runs(thread_id, bot_id, status, queued_at, run_id);
CREATE UNIQUE INDEX IF NOT EXISTS browser_channel_runs_active_slot
  ON browser_channel_runs(thread_id, bot_id)
  WHERE status IN ('running','needs_you','taken_over');
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('browser_channel_runs_version', '1');
UPDATE schema_meta SET value = '38' WHERE key = 'schema_version';
