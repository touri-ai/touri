CREATE TABLE browser_channel_runs_next (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  current_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES bot_groups(id) ON DELETE CASCADE,
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
INSERT INTO browser_channel_runs_next
  SELECT run_id,run_id,group_id,thread_id,bot_id,requester_person_id,responsible_person_id,
    controller_person_id,status,queued_at,started_at,needs_you_at,escalated_at,finished_at
  FROM browser_channel_runs;
DROP TABLE browser_channel_runs;
ALTER TABLE browser_channel_runs_next RENAME TO browser_channel_runs;
CREATE INDEX browser_channel_runs_bot_queue ON browser_channel_runs(bot_id,status,queued_at,run_id);
CREATE INDEX browser_channel_runs_current ON browser_channel_runs(current_run_id);
CREATE INDEX browser_channel_runs_thread_queue ON browser_channel_runs(thread_id,bot_id,status,queued_at,run_id);
UPDATE browser_channel_runs SET status='queued', controller_person_id=NULL
  WHERE status IN ('running','needs_you','taken_over') AND EXISTS (
    SELECT 1 FROM browser_channel_runs previous
    WHERE previous.bot_id=browser_channel_runs.bot_id AND previous.status IN ('running','needs_you','taken_over')
      AND (previous.queued_at < browser_channel_runs.queued_at OR
        (previous.queued_at = browser_channel_runs.queued_at AND previous.run_id < browser_channel_runs.run_id))
  );
CREATE UNIQUE INDEX browser_channel_runs_active_slot ON browser_channel_runs(bot_id)
  WHERE status IN ('running','needs_you','taken_over');
INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('browser_bot_arbitration_version','1');
UPDATE schema_meta SET value='42' WHERE key='schema_version';
