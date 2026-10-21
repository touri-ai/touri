ALTER TABLE browser_tabs ADD COLUMN private_document_ids_json TEXT NOT NULL DEFAULT '[]';
UPDATE browser_tabs SET private_document_ids_json = '[0]' WHERE private_input = 1;
UPDATE schema_meta SET value = '46' WHERE key = 'schema_version';
