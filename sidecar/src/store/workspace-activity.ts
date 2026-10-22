import type { Database } from "bun:sqlite"
import type { BrowserChannelRun, BrowserChannelRunStatus, Message, MessageStatus, Run } from "@touri/contracts"
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

export const WORKSPACE_MESSAGES_SQL = `
  WITH visible AS MATERIALIZED (
    SELECT t.id FROM threads t JOIN bots b ON b.id = t.bot_id
    WHERE t.archived_at IS NULL AND b.archived_at IS NULL AND t.group_thread_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM bot_deletions d WHERE d.bot_id = b.id)
      AND (/* scope */ 1 = 1)
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
    UNION SELECT m.rowid FROM workspace_message_attention a INDEXED BY workspace_attention_pending
      JOIN messages m ON m.thread_id = a.thread_id AND m.id = a.message_id
      JOIN visible t ON t.id = a.thread_id
      WHERE a.type = 'approval' AND a.decision = 'pending'
    UNION SELECT m.rowid FROM notifications n INDEXED BY notifications_pending_request
      CROSS JOIN workspace_message_attention a ON a.approval_id = n.request_id AND a.thread_id = n.thread_id
      JOIN messages m ON m.thread_id = a.thread_id AND m.id = a.message_id
      JOIN visible t ON t.id = a.thread_id
      WHERE n.resolved_at IS NULL AND n.request_id IS NOT NULL AND a.type = 'approval'
  )
  SELECT m.seq, m.generation, m.updated_seq, m.client_nonce, m.delivery_status, m.delivery_deadline,
    m.id, m.thread_id, m.parent_id, m.role, m.kind, m.status, m.run_id,
    substr(m.text, 1, 512) AS text,
    (SELECT json_group_array(json(part_json)) FROM (
      SELECT a.part_json FROM workspace_message_attention a
      WHERE a.thread_id = m.thread_id AND a.message_id = m.id ORDER BY a.part_index
    )) AS parts_json,
    m.sender_json, m.source, m.created_at, m.updated_at
  FROM messages m WHERE m.rowid IN (SELECT row_id FROM selected)
`

export const WORKSPACE_RUNS_SQL = `
  WITH selected AS (
    SELECT (SELECT rowid FROM runs WHERE thread_id = t.id
      ORDER BY queued_at DESC, rowid DESC LIMIT 1) AS row_id FROM threads t
    UNION SELECT rowid FROM runs INDEXED BY runs_active_workspace WHERE status IN ('queued', 'starting', 'running')
  )
  SELECT r.*, coalesce(root.thread_id, r.thread_id) AS thread_id, link.turn_id AS group_turn_id FROM runs r
  LEFT JOIN group_run_links link ON link.run_id = r.id
  LEFT JOIN runs root ON root.id = link.turn_id
  JOIN threads t ON t.id = coalesce(root.thread_id, r.thread_id)
  JOIN bots b ON b.id = r.bot_id
  WHERE r.rowid IN (SELECT row_id FROM selected)
    AND t.archived_at IS NULL AND b.archived_at IS NULL AND t.group_thread_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM bot_deletions d WHERE d.bot_id = b.id)
    AND (/* scope */ 1 = 1)
`

type RawBrowserChannelRun = {
  current_run_id: string
  run_id: string
  group_id: string
  thread_id: string
  bot_id: string
  requester_person_id: string | null
  responsible_person_id: string | null
  controller_person_id: string | null
  status: BrowserChannelRunStatus
  queue_position: number | null
  queued_at: number
  started_at: number | null
  needs_you_at: number | null
  escalated_at: number | null
  finished_at: number | null
}

export const WORKSPACE_BROWSER_RUNS_SQL = `
  SELECT c.*,
    CASE WHEN c.status = 'queued' THEN 1 + (
      SELECT COUNT(*) FROM browser_channel_runs queued
      WHERE queued.bot_id = c.bot_id AND queued.status = 'queued'
        AND (queued.queued_at < c.queued_at OR (queued.queued_at = c.queued_at AND queued.run_id < c.run_id))
    ) ELSE NULL END AS queue_position
  FROM browser_channel_runs c
  JOIN bot_groups g ON g.id = c.group_id
  JOIN threads t ON t.id = c.thread_id
  JOIN bots b ON b.id = c.bot_id
  WHERE c.status IN ('queued','running','needs_you','taken_over')
    AND t.archived_at IS NULL AND b.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM bot_deletions d WHERE d.bot_id = b.id)
    AND (/* scope */ 1 = 1)
  ORDER BY c.group_id, c.thread_id, c.bot_id, c.queued_at, c.run_id
  LIMIT 100
`

const asBrowserChannelRun = (
  row: RawBrowserChannelRun,
  personName: (personId: string) => string | null,
): BrowserChannelRun => ({
  runId: row.run_id,
  activeRunId: row.current_run_id,
  groupId: row.group_id,
  threadId: row.thread_id,
  botId: row.bot_id,
  requesterPersonId: row.requester_person_id,
  requesterName: row.requester_person_id ? personName(row.requester_person_id) : null,
  responsiblePersonId: row.responsible_person_id,
  controllerPersonId: row.controller_person_id,
  controllerName: row.controller_person_id ? personName(row.controller_person_id) : null,
  status: row.status,
  queuePosition: row.queue_position,
  queuedAt: row.queued_at,
  startedAt: row.started_at,
  needsYouAt: row.needs_you_at,
  escalatedAt: row.escalated_at,
  finishedAt: row.finished_at,
})

export const readWorkspaceActivity = (
  database: Database,
  scope?: { personId: string; channelIds: Array<string> },
  personName: (personId: string) => string | null = () => null,
): { messages: RawMessage[]; runs: Run[]; browserRuns: Array<BrowserChannelRun> } => {
  // At most five indexed message probes per visible thread, plus open approvals.
  // Never parse historical tool output or visit every completed run on a read.
  const channelScope = scope?.channelIds.length
    ? `t.group_id IN (${scope.channelIds.map(() => "?").join(",")}) OR `
    : ""
  const personScope = scope
    ? `${channelScope}(t.group_id IS NULL AND (t.owner_person_id = ? OR (t.owner_person_id IS NULL AND ? = 'owner')))`
    : "1 = 1"
  const values = scope ? [...scope.channelIds, scope.personId, scope.personId] : []
  const messages = database
    .query(WORKSPACE_MESSAGES_SQL.replace("/* scope */ 1 = 1", personScope))
    .all(...values) as RawMessage[]
  const runs = database
    .query(WORKSPACE_RUNS_SQL.replace("/* scope */ 1 = 1", personScope))
    .all(...values)
    .flatMap((row) => {
      const run = toRun(row)
      return run ? [run] : []
    })
  const browserScope = scope
    ? scope.channelIds.length
      ? `c.group_id IN (${scope.channelIds.map(() => "?").join(",")})`
      : "0 = 1"
    : "1 = 1"
  const browserRuns = database
    .query(WORKSPACE_BROWSER_RUNS_SQL.replace("/* scope */ 1 = 1", browserScope))
    .all(...(scope?.channelIds ?? []))
    .map((row) => asBrowserChannelRun(row as RawBrowserChannelRun, personName))
  return { messages, runs, browserRuns }
}
