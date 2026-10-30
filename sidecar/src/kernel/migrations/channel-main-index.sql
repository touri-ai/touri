CREATE INDEX IF NOT EXISTS threads_channel_created ON threads(group_id, created_at, id) WHERE group_thread_id IS NULL AND archived_at IS NULL;
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('channel_main_index_version', '1');
