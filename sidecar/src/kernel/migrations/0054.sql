ALTER TABLE routines ADD COLUMN kind TEXT NOT NULL DEFAULT 'bot' CHECK (kind IN ('bot', 'script'));
ALTER TABLE routines ADD COLUMN command TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN env_file TEXT;
CREATE INDEX IF NOT EXISTS routine_runs_dispatch ON routine_runs(routine_id, scheduled_for)
  WHERE status IN ('running', 'scheduled');
UPDATE schema_meta SET value = '54' WHERE key = 'schema_version';
