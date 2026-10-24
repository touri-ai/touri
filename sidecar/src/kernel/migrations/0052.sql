-- Authentication owns person identities in the separate host auth store.
CREATE TABLE IF NOT EXISTS notification_reads (
  person_id TEXT NOT NULL,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, notification_id)
);
CREATE INDEX IF NOT EXISTS notification_reads_notification ON notification_reads(notification_id);
UPDATE schema_meta SET value = '52' WHERE key = 'schema_version';
