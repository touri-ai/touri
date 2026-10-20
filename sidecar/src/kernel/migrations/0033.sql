-- Column additions are guarded by table_info in db.ts so a partial startup can resume safely.
CREATE INDEX IF NOT EXISTS threads_owner_person_active ON threads(owner_person_id, group_id, archived_at, updated_at);
CREATE INDEX IF NOT EXISTS bots_responsible_person_active ON bots(responsible_person_id, archived_at);
CREATE TABLE IF NOT EXISTS attachment_people (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (attachment_id, person_id)
);
CREATE TABLE IF NOT EXISTS attachment_message_refs (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS attachment_message_refs_attachment ON attachment_message_refs(attachment_id, thread_id);
CREATE TRIGGER IF NOT EXISTS messages_attachment_refs_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO attachment_message_refs(thread_id, message_id, attachment_id)
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.attachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.attachmentId') = 'text'
    UNION
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.outputAttachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.outputAttachmentId') = 'text';
END;
CREATE TRIGGER IF NOT EXISTS messages_attachment_refs_update AFTER UPDATE OF parts_json ON messages BEGIN
  DELETE FROM attachment_message_refs WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
  INSERT OR IGNORE INTO attachment_message_refs(thread_id, message_id, attachment_id)
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.attachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.attachmentId') = 'text'
    UNION
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.outputAttachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.outputAttachmentId') = 'text';
END;
CREATE TRIGGER IF NOT EXISTS messages_attachment_refs_delete AFTER DELETE ON messages BEGIN
  DELETE FROM attachment_message_refs WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
END;
