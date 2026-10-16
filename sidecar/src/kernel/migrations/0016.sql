-- Host folder grants are user-owned configuration, never a bot tool capability.
ALTER TABLE bots ADD COLUMN folders_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bots ADD COLUMN any_folder_access INTEGER NOT NULL DEFAULT 0 CHECK (any_folder_access IN (0, 1));
ALTER TABLE bot_machines ADD COLUMN folder_fingerprint TEXT NOT NULL DEFAULT '';
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '16');
