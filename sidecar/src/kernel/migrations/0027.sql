-- Group deletion and bot membership cleanup use these reverse lookups.
CREATE INDEX IF NOT EXISTS group_members_bot ON group_members(bot_id);
CREATE INDEX IF NOT EXISTS group_turns_group ON group_turns(group_id);
CREATE INDEX IF NOT EXISTS routines_group ON routines(group_id);
UPDATE schema_meta SET value = '27' WHERE key = 'schema_version';
