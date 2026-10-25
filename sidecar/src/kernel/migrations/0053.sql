ALTER TABLE messages ADD COLUMN attachment_revision INTEGER NOT NULL DEFAULT 0;

-- Retention writes bypass transcript revisions but must invalidate historical reference batches.
CREATE TRIGGER messages_attachment_revision AFTER UPDATE OF parts_json ON messages
WHEN NEW.parts_json IS NOT OLD.parts_json BEGIN
  UPDATE messages SET attachment_revision = attachment_revision + 1
    WHERE thread_id = NEW.thread_id AND id = NEW.id;
END;

UPDATE schema_meta SET value = '53' WHERE key = 'schema_version';
