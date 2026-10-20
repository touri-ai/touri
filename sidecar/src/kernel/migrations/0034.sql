ALTER TABLE bots ADD COLUMN automatic_conversation_mode TEXT NOT NULL DEFAULT 'main'
  CHECK (automatic_conversation_mode IN ('main', 'task'));

-- Preserve the saved per-run routine behavior for existing bots that have routines using it.
UPDATE bots
SET automatic_conversation_mode = 'task'
WHERE EXISTS (
  SELECT 1 FROM routines
  WHERE routines.bot_id = bots.id AND routines.continuity = 'new-thread'
);

UPDATE schema_meta SET value = '34' WHERE key = 'schema_version';
