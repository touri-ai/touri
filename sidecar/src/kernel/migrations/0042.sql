CREATE INDEX IF NOT EXISTS browser_resume_requests_next_turn ON browser_resume_requests(next_turn_id);
UPDATE schema_meta SET value = '42' WHERE key = 'schema_version';
