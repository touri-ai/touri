import type { Database } from "bun:sqlite"
import type { Message, MessageStatus, Run } from "@touri/contracts"
import { toRun } from "../runtime/persistence"

export type RawMessage = {
  seq: number
  generation: number
  updated_seq: number
  client_nonce: string | null
  delivery_status: NonNullable<Message["delivery"]>["status"] | null
  delivery_deadline: number | null
  id: string
  thread_id: string
  parent_id: string | null
  role: Message["role"]
  kind: Message["kind"]
  status: MessageStatus
  run_id: string | null
  text: string
  parts_json: string
  sender_json: string | null
  source: string
  created_at: number
  updated_at: number
}

export const readWorkspaceActivity = (database: Database): { messages: RawMessage[]; runs: Run[] } => {
  // Read only sidebar rows. Tool output and full prose stay behind the thread endpoint.
  const messages = database
    .query(`
    WITH visible AS (
      SELECT t.id FROM threads t JOIN bots b ON b.id = t.bot_id
      WHERE t.archived_at IS NULL AND b.archived_at IS NULL AND t.group_thread_id IS NULL
    ), selected AS (
      SELECT (SELECT rowid FROM messages WHERE thread_id = t.id
        AND (trim(text) <> '' OR status IN ('failed', 'canceled') OR parts_json LIKE '%"type":"approval"%' OR parts_json LIKE '%"type":"notice"%')
        ORDER BY created_at DESC, rowid DESC LIMIT 1) AS row_id FROM visible t
      UNION SELECT (SELECT rowid FROM messages WHERE thread_id = t.id AND role = 'assistant'
        ORDER BY created_at DESC, rowid DESC LIMIT 1) FROM visible t
      UNION SELECT (SELECT rowid FROM messages WHERE thread_id = t.id AND role = 'assistant'
        ORDER BY updated_at DESC, rowid DESC LIMIT 1) FROM visible t
      UNION SELECT (SELECT rowid FROM messages WHERE thread_id = t.id AND role = 'assistant' AND status <> 'streaming'
        ORDER BY updated_at DESC, rowid DESC LIMIT 1) FROM visible t
      UNION SELECT (SELECT rowid FROM messages WHERE thread_id = t.id AND role = 'assistant' AND status = 'complete'
        ORDER BY updated_at DESC, rowid DESC LIMIT 1) FROM visible t
      UNION SELECT m.rowid FROM messages m JOIN visible t ON t.id = m.thread_id, json_each(m.parts_json) p
        WHERE json_extract(p.value, '$.type') = 'approval' AND (
          json_extract(p.value, '$.decision') = 'pending' OR EXISTS (
            SELECT 1 FROM notifications n WHERE n.thread_id = m.thread_id AND n.resolved_at IS NULL
              AND n.request_id = json_extract(p.value, '$.approvalId')
          )
        )
    )
    SELECT m.*, substr(m.text, 1, 512) AS text,
      (SELECT json_group_array(json(p.value)) FROM json_each(m.parts_json) p
        WHERE json_extract(p.value, '$.type') IN ('approval', 'notice')) AS parts_json
    FROM messages m WHERE m.rowid IN (SELECT row_id FROM selected)
  `)
    .all() as RawMessage[]
  const runs = database
    .query(`
    SELECT r.*, coalesce(root.thread_id, r.thread_id) AS thread_id FROM runs r
    LEFT JOIN group_run_links link ON link.run_id = r.id
    LEFT JOIN runs root ON root.id = link.turn_id
    JOIN threads t ON t.id = coalesce(root.thread_id, r.thread_id)
    JOIN bots b ON b.id = r.bot_id
    WHERE t.archived_at IS NULL AND b.archived_at IS NULL AND t.group_thread_id IS NULL
      AND (r.status IN ('queued', 'starting', 'running') OR r.id = (
        SELECT id FROM runs WHERE thread_id = r.thread_id ORDER BY queued_at DESC, rowid DESC LIMIT 1
      ))
  `)
    .all()
    .flatMap((row) => {
      const run = toRun(row)
      return run ? [run] : []
    })
  return { messages, runs }
}
