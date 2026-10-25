CREATE INDEX IF NOT EXISTS attachments_origin_path ON attachments(origin_path, id);
CREATE INDEX IF NOT EXISTS attachments_path ON attachments(path, id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('image_evidence_indexes_version', '1');
