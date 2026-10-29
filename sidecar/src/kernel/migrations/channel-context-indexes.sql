CREATE INDEX IF NOT EXISTS messages_channel_user_seq ON messages(thread_id, seq) WHERE role = 'user';
CREATE INDEX IF NOT EXISTS messages_channel_reply_seq ON messages(thread_id, seq) WHERE role <> 'user';
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('channel_context_indexes_version', '1');
