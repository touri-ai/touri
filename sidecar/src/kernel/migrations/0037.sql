ALTER TABLE browser_tabs ADD COLUMN private_after_takeover INTEGER NOT NULL DEFAULT 0 CHECK (private_after_takeover IN (0,1));
ALTER TABLE browser_tabs ADD COLUMN takeover_reason TEXT;
UPDATE schema_meta SET value = '37' WHERE key = 'schema_version';
