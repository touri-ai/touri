ALTER TABLE browser_channel_runs ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX browser_channel_runs_resume ON browser_channel_runs(resume_pending,status);
INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('browser_request_resume_version','1');
UPDATE schema_meta SET value='44' WHERE key='schema_version';
