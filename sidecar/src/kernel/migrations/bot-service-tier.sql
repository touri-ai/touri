ALTER TABLE bots ADD COLUMN service_tier TEXT
  CHECK (service_tier IS NULL OR (service_tier = 'fast' AND provider = 'codex'));
INSERT INTO schema_meta(key,value) VALUES ('bot_service_tier_version','1');
