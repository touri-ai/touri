-- Keep chronology and channel metadata reads independent of unrelated history.
CREATE INDEX messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX group_message_links_message ON group_message_links(message_id, visible_message_id);
CREATE INDEX bot_groups_created ON bot_groups(created_at);
CREATE INDEX threads_channel_updated ON threads(group_id, updated_at DESC)
  WHERE group_thread_id IS NULL AND archived_at IS NULL;
CREATE INDEX runs_active_order ON runs(queued_at)
  WHERE status IN ('queued', 'starting', 'running');
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('hot_read_indexes_version', '1');
UPDATE schema_meta SET value = '48' WHERE key = 'schema_version';
