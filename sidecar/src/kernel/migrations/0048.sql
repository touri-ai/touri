CREATE INDEX IF NOT EXISTS runs_request ON runs(thread_id, request_message_id, queued_at DESC);
UPDATE schema_meta SET value = '48' WHERE key = 'schema_version';
