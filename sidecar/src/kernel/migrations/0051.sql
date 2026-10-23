CREATE TABLE IF NOT EXISTS push_devices (
  device_id TEXT PRIMARY KEY,
  locale TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_deliveries (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, device_id)
);
CREATE INDEX IF NOT EXISTS push_deliveries_due ON push_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS push_deliveries_expiry ON push_deliveries(expires_at);
UPDATE schema_meta SET value = '51' WHERE key = 'schema_version';
