-- Offline, read-only watchdog diagnostic. Bind the start of the observation window
-- (epoch milliseconds). Coordination rows describe dispatch, not provider work.
SELECT r1.bot_id, r1.id AS first_run_id, r2.id AS second_run_id
FROM runs r1
JOIN runs r2 ON r1.bot_id = r2.bot_id AND r1.id < r2.id
  AND abs(r1.started_at - r2.started_at) < 1000
  AND r1.thread_id <> r2.thread_id
LEFT JOIN group_run_links first_link ON first_link.run_id = r1.id
LEFT JOIN group_run_links second_link ON second_link.run_id = r2.id
WHERE r1.started_at > ?
  AND r1.trigger = 'user' AND r2.trigger = 'user'
  AND NOT EXISTS (SELECT 1 FROM group_turns WHERE run_id = r1.id)
  AND NOT EXISTS (SELECT 1 FROM group_turns WHERE run_id = r2.id)
  AND (
    (r1.request_message_id IS NOT NULL AND r1.request_message_id = r2.request_message_id)
    OR first_link.turn_id = second_link.turn_id
  );
