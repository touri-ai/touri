CREATE TABLE thread_deletions (
  thread_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  group_id TEXT,
  owner_person_id TEXT,
  responsible_person_id TEXT,
  phase TEXT NOT NULL,
  event_cursor INTEGER NOT NULL DEFAULT 0,
  event_high_water INTEGER NOT NULL DEFAULT 0,
  transcript_cursor INTEGER NOT NULL DEFAULT 0,
  message_cursor TEXT NOT NULL DEFAULT '',
  record_task INTEGER NOT NULL DEFAULT 0,
  record_cursor INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE thread_deletion_attachments (
  thread_id TEXT NOT NULL REFERENCES thread_deletions(thread_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, attachment_id)
);
CREATE INDEX thread_deletions_created ON thread_deletions(created_at, thread_id);
CREATE INDEX threads_archived_page ON threads(bot_id, id DESC) WHERE archived_at IS NOT NULL AND group_id IS NULL;
CREATE INDEX threads_group_thread ON threads(group_thread_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('thread_deletion_version', '1');
UPDATE schema_meta SET value = '37' WHERE key = 'schema_version';
