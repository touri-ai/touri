-- One person's read position per channel conversation; replies that finish later are unread.
CREATE TABLE IF NOT EXISTS channel_reads (
  person_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, thread_id)
);
CREATE INDEX IF NOT EXISTS channel_reads_thread ON channel_reads(thread_id);
-- Replies that finished before read tracking existed are not news; count from the upgrade on.
INSERT OR IGNORE INTO schema_meta(key, value)
  VALUES ('channel_reads_since', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));
