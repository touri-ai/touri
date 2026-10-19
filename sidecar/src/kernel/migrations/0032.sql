ALTER TABLE bots ADD COLUMN team_builder INTEGER NOT NULL DEFAULT 0 CHECK (team_builder IN (0,1));
UPDATE schema_meta SET value = '32' WHERE key = 'schema_version';
