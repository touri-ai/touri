CREATE TABLE browser_channel_runs_next (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  request_id TEXT,
  active_run_id TEXT,
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
SELECT c.run_id, COALESCE(parent.request_message_id, r.request_message_id, c.run_id), c.run_id, c.group_id,
  c.thread_id, c.bot_id, c.requester_person_id, c.responsible_person_id, c.controller_person_id,
  c.status, c.queued_at, c.started_at, c.needs_you_at, c.escalated_at, c.finished_at
FROM browser_channel_runs c JOIN runs r ON r.id = c.run_id
LEFT JOIN group_run_links link ON link.run_id = c.run_id
LEFT JOIN runs parent ON parent.id = link.turn_id;
WITH ranked AS (
  SELECT run_id, ROW_NUMBER() OVER (PARTITION BY bot_id ORDER BY queued_at, run_id) AS position
  FROM browser_channel_runs_next WHERE status IN ('running','needs_you','taken_over')
)
UPDATE browser_channel_runs_next
SET status = 'queued', controller_person_id = NULL, needs_you_at = NULL, escalated_at = NULL
WHERE run_id IN (SELECT run_id FROM ranked WHERE position > 1);
DROP TABLE browser_channel_runs;
ALTER TABLE browser_channel_runs_next RENAME TO browser_channel_runs;
CREATE INDEX browser_channel_runs_queue
  ON browser_channel_runs(group_id, thread_id, bot_id, status, queued_at, run_id);
CREATE INDEX browser_channel_runs_thread_queue
  ON browser_channel_runs(thread_id, bot_id, status, queued_at, run_id);
CREATE UNIQUE INDEX browser_channel_runs_request ON browser_channel_runs(bot_id, request_id);
CREATE INDEX browser_channel_runs_tab_history ON browser_channel_runs(thread_id, bot_id, queued_at DESC, run_id DESC);
CREATE INDEX browser_channel_runs_bot_queue
  ON browser_channel_runs(bot_id, status, queued_at, run_id);
CREATE UNIQUE INDEX browser_channel_runs_active_slot
  ON browser_channel_runs(bot_id) WHERE status IN ('running','needs_you','taken_over');
CREATE TABLE browser_resume_requests (
  previous_run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  next_turn_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
);
CREATE TABLE browser_request_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  request_run_id TEXT NOT NULL REFERENCES browser_channel_runs(run_id) ON DELETE CASCADE
);
INSERT INTO browser_request_runs SELECT run_id, run_id FROM browser_channel_runs;
CREATE INDEX browser_request_runs_request ON browser_request_runs(request_run_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('browser_bot_queue_version', '1');
UPDATE schema_meta SET value = '41' WHERE key = 'schema_version';
