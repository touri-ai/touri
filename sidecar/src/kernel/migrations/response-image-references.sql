DROP TRIGGER IF EXISTS messages_attachment_refs_insert;
DROP TRIGGER IF EXISTS messages_attachment_refs_update;
CREATE TRIGGER messages_attachment_refs_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO attachment_message_refs(thread_id, message_id, attachment_id)
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.attachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.attachmentId') = 'text'
    UNION
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.outputAttachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.outputAttachmentId') = 'text'
    UNION
    SELECT NEW.thread_id, NEW.id, json_extract(image.value, '$.attachmentId')
    FROM json_each(NEW.parts_json) part, json_each(part.value, '$.images') image
    WHERE json_extract(part.value, '$.type') = 'text'
      AND json_type(image.value, '$.attachmentId') = 'text';
END;
CREATE TRIGGER messages_attachment_refs_update AFTER UPDATE OF parts_json ON messages BEGIN
  DELETE FROM attachment_message_refs WHERE thread_id = OLD.thread_id AND message_id = OLD.id;
  INSERT OR IGNORE INTO attachment_message_refs(thread_id, message_id, attachment_id)
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.attachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.attachmentId') = 'text'
    UNION
    SELECT NEW.thread_id, NEW.id, json_extract(part.value, '$.outputAttachmentId')
    FROM json_each(NEW.parts_json) part
    WHERE json_type(part.value, '$.outputAttachmentId') = 'text'
    UNION
    SELECT NEW.thread_id, NEW.id, json_extract(image.value, '$.attachmentId')
    FROM json_each(NEW.parts_json) part, json_each(part.value, '$.images') image
    WHERE json_extract(part.value, '$.type') = 'text'
      AND json_type(image.value, '$.attachmentId') = 'text';
END;
INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('response_image_references_version','1');
