ALTER TABLE browser_tabs ADD COLUMN private_input INTEGER NOT NULL DEFAULT 0 CHECK (private_input IN (0, 1));
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('browser_private_input_version', '1');
UPDATE schema_meta SET value = '40' WHERE key = 'schema_version';
