-- Offline diagnostic only. Bind the queued-at cutoff (Unix milliseconds).
-- Channel coordination is serialized per group, independently of the selected bot.
SELECT waiting.id AS run_id, waiting.bot_id, waiting.queued_at,
       CASE WHEN channel.run_id IS NOT NULL THEN 'channel' ELSE 'bot' END AS wait_scope,
       (SELECT active.id
        FROM runs active
        WHERE active.status IN ('starting', 'running')
          AND active.id <> waiting.id
          AND CASE WHEN channel.run_id IS NOT NULL THEN
            EXISTS (SELECT 1 FROM group_turns blocker
                    WHERE blocker.run_id = active.id AND blocker.group_id = channel.group_id)
          ELSE active.bot_id = waiting.bot_id
            AND NOT EXISTS (SELECT 1 FROM group_turns coordinator WHERE coordinator.run_id = active.id)
          END
        ORDER BY active.started_at, active.id LIMIT 1) AS blocker_run_id
FROM runs waiting
LEFT JOIN group_turns channel ON channel.run_id = waiting.id
WHERE waiting.status = 'queued' AND waiting.queued_at < ?
ORDER BY waiting.queued_at, waiting.id;
