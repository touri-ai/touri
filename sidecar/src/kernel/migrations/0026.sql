-- Resolution stays in notifications so every surface observes the same history.
CREATE TABLE IF NOT EXISTS recovery_tasks (
  id TEXT PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  turn_id TEXT
);
CREATE INDEX IF NOT EXISTS recovery_tasks_notification ON recovery_tasks(notification_id);
UPDATE schema_meta SET value = '26' WHERE key = 'schema_version';
