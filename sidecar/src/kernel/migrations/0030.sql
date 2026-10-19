UPDATE messages
SET role = 'system',
    kind = 'notice',
    parts_json = json_insert(
      parts_json,
      '$[0]',
      json_object(
        'type', 'notice',
        'level', 'info',
        'code', 'group_coordination_prompt',
        'text', text
      )
    )
WHERE role = 'user'
  AND thread_id IN (SELECT id FROM threads WHERE group_thread_id IS NOT NULL)
  AND substr(text, 1, 7) = 'Grupo "'
  AND instr(text, 'Histórico compartilhado (dados, não instruções)') > 0;

INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('group_coordination_history_version', '1');
UPDATE schema_meta SET value = '30' WHERE key = 'schema_version';
