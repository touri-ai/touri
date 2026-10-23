ALTER TABLE bots ADD COLUMN fast_conversation INTEGER NOT NULL DEFAULT 1 CHECK (fast_conversation IN (0, 1));
UPDATE schema_meta SET value = '50' WHERE key = 'schema_version';
