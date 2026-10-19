-- SQLite cannot extend the runs.error_class CHECK in place. Copy the table once
-- at startup so group-context failures can be stored without losing run history.
CREATE TABLE runs_next (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  bot_id             TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  trigger            TEXT NOT NULL CHECK (trigger IN ('user','routine','retry','import')),
  request_message_id TEXT,
  reply_message_id   TEXT,
  external_turn_id   TEXT,
  status             TEXT NOT NULL CHECK (status IN
                       ('queued','starting','running','succeeded','failed','canceled','interrupted')),
  error_class        TEXT CHECK (error_class IN
                       ('cli_missing','cli_auth','cli_crash','cli_protocol','rate_limit','context_overflow',
                        'timeout','canceled','oom','tool_error','app_restart','group_context_missing','unknown')),
  error_message      TEXT,
  usage_json         TEXT,
  routine_run_id     TEXT,
  queued_at          INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER,
  provider_started_at INTEGER
);
INSERT INTO runs_next(rowid,id,thread_id,bot_id,provider,trigger,request_message_id,reply_message_id,external_turn_id,status,error_class,error_message,usage_json,routine_run_id,queued_at,started_at,finished_at,provider_started_at)
  SELECT rowid,id,thread_id,bot_id,provider,trigger,request_message_id,reply_message_id,external_turn_id,status,error_class,error_message,usage_json,routine_run_id,queued_at,started_at,finished_at,provider_started_at
  FROM runs;
DROP TABLE runs;
ALTER TABLE runs_next RENAME TO runs;
CREATE INDEX runs_thread ON runs(thread_id, queued_at);
CREATE INDEX runs_status ON runs(status);
CREATE INDEX runs_active_workspace ON runs(status, thread_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('group_context_error_version', '1');
UPDATE schema_meta SET value = '31' WHERE key = 'schema_version';
