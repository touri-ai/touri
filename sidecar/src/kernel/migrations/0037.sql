ALTER TABLE browser_tabs ADD COLUMN private_input INTEGER NOT NULL DEFAULT 0 CHECK (private_input IN (0, 1));
UPDATE schema_meta SET value = '37' WHERE key = 'schema_version';
