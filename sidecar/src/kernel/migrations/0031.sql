-- Keep one durable idempotency result for the in-flight stream batch. The
-- worker serializes batches, so the next commit safely replaces this marker.
CREATE TABLE IF NOT EXISTS stream_writer_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  batch_id TEXT,
  result_json TEXT
);
INSERT OR IGNORE INTO stream_writer_state(id) VALUES (1);
UPDATE schema_meta SET value = '31' WHERE key = 'schema_version';
