-- Expiry runs every second; revoked history must not be scanned each time.
CREATE INDEX IF NOT EXISTS computer_grants_active_expiry
  ON computer_grants(expires_at) WHERE revoked_at IS NULL;
UPDATE schema_meta SET value = '29' WHERE key = 'schema_version';
