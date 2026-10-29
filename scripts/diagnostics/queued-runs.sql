-- Offline diagnostic only. Bind the queued-at cutoff (Unix milliseconds).
-- Only attribute direct conflicts visible in persisted scheduler identities.
WITH waits AS (
SELECT waiting.id AS run_id, waiting.bot_id, waiting.queued_at,
       CASE WHEN channel.run_id IS NOT NULL THEN 'channel' ELSE 'thread' END AS wait_scope,
       (SELECT active.id
        FROM runs active
        WHERE active.status IN ('starting', 'running')
          AND active.id <> waiting.id
          AND CASE WHEN channel.run_id IS NOT NULL THEN
            EXISTS (SELECT 1 FROM group_turns blocker
                    WHERE blocker.run_id = active.id AND blocker.group_id = channel.group_id
                      AND EXISTS (
                        SELECT 1 FROM json_each(channel.recipients_json) recipient
                        WHERE recipient.value IN (SELECT value FROM json_each(blocker.recipients_json))
                          OR EXISTS (
                            SELECT 1 FROM group_run_links link JOIN runs member ON member.id = link.run_id
                            WHERE link.turn_id = blocker.run_id AND link.depth > 0
                              AND member.bot_id = recipient.value
                              AND member.status IN ('queued', 'starting', 'running')
                          )
                      ))
          ELSE active.thread_id = waiting.thread_id
            AND NOT EXISTS (SELECT 1 FROM group_turns coordinator WHERE coordinator.run_id = active.id)
          END
        ORDER BY active.started_at, active.id LIMIT 1) AS blocker_run_id
FROM runs waiting
LEFT JOIN group_turns channel ON channel.run_id = waiting.id
WHERE waiting.status = 'queued' AND waiting.queued_at < ?
)
SELECT waits.*, blocker.started_at AS blocker_started_at,
       CASE WHEN waits.wait_scope = 'channel' THEN (
         SELECT MAX(reply.updated_at)
         FROM group_run_links link
         JOIN runs execution ON execution.id = link.run_id
         JOIN messages reply ON reply.thread_id = execution.thread_id
           AND reply.id = execution.reply_message_id AND reply.run_id = execution.id
         WHERE link.turn_id = blocker.id AND execution.status IN ('starting', 'running')
           AND execution.bot_id IN (SELECT value FROM json_each(channel.recipients_json))
       ) ELSE (
         SELECT reply.updated_at FROM messages reply
         WHERE reply.thread_id = blocker.thread_id AND reply.id = blocker.reply_message_id
           AND reply.run_id = blocker.id
       ) END AS blocker_last_progress_at
FROM waits
LEFT JOIN runs blocker ON blocker.id = waits.blocker_run_id
LEFT JOIN group_turns channel ON channel.run_id = waits.run_id
ORDER BY waits.queued_at, waits.run_id;
