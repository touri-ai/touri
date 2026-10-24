import type { Database } from "bun:sqlite"
import {
  avatarColorFor,
  avatarShapeFor,
  type EpochMs,
  type NotificationRecord,
  type NotifyInput,
  type NotifyKind,
  type NotifyResolution,
} from "@touri/contracts"
import { ATTENTION_KINDS, BACKLOG_WINDOW_MS, MESSAGE_KINDS, MESSAGE_REPLAY_MS } from "./kinds"

type Row = {
  id: number
  kind: string
  level: string
  bot_id: string | null
  thread_id: string | null
  title: string
  body: string
  request_id: string | null
  target_person_id: string | null
  created_at: number
  resolved_at: number | null
  resolution: string | null
  bot_name: string | null
  bot_color: string | null
  bot_avatar_shape: NotificationRecord["avatarShape"] | null
  bot_avatar_seed: string | null
}

export type LogEntry = { seq: number; type: "notify" | "resolved"; notification: NotificationRecord }

const SELECT = `SELECT n.*, b.name AS bot_name, b.color AS bot_color, b.avatar_shape AS bot_avatar_shape, b.avatar_seed AS bot_avatar_seed
  FROM notifications n LEFT JOIN bots b ON b.id = n.bot_id`

export const PENDING_NOTIFICATIONS_SQL = `${SELECT}
  WHERE n.resolved_at IS NULL AND n.created_at >= ?
    AND n.kind IN (${[...ATTENTION_KINDS].map((kind) => `'${kind}'`).join(", ")})
  ORDER BY n.id ASC`

const levelFor = (kind: NotifyKind): NotificationRecord["level"] => {
  if (kind === "turn-failed" || kind === "routine-failed" || kind === "incident") return "error"
  if (MESSAGE_KINDS.has(kind)) return "info"
  return "warning"
}

const asRecord = (row: Row): NotificationRecord => {
  const botId = row.bot_id
  const identity = {
    id: botId ?? `anon-${row.id}`,
    color: row.bot_color,
    avatarShape: row.bot_avatar_shape,
    avatarSeed: row.bot_avatar_seed,
  }
  return {
    id: row.id,
    kind: row.kind as NotifyKind,
    level: row.level as NotificationRecord["level"],
    botId,
    botName: row.bot_name,
    botColor: avatarColorFor(identity),
    avatarShape: avatarShapeFor(identity),
    avatarSeed: identity.avatarSeed,
    threadId: row.thread_id,
    title: row.title,
    body: row.body,
    requestId: row.request_id,
    targetPersonId: row.target_person_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution as NotifyResolution | null,
  }
}

export const createNotificationStore = ({ db, now = Date.now }: { db: Database; now?: () => EpochMs }) => {
  const get = (id: number): NotificationRecord | null => {
    const row = db.query(`${SELECT} WHERE n.id = ?`).get(id) as Row | null
    return row ? asRecord(row) : null
  }

  const byRequestId = (requestId: string): NotificationRecord | null => {
    const row = db.query(`${SELECT} WHERE n.request_id = ? ORDER BY n.id DESC LIMIT 1`).get(requestId) as Row | null
    return row ? asRecord(row) : null
  }

  const appendLog = ({ type, notificationId }: { type: "notify" | "resolved"; notificationId: number }): number => {
    const result = db
      .query("INSERT INTO notification_log (type, notification_id, at) VALUES (?, ?, ?)")
      .run(type, notificationId, now())
    return Number(result.lastInsertRowid)
  }

  const insert = (input: NotifyInput): { notification: NotificationRecord; seq: number } => {
    const result = db
      .query(
        "INSERT INTO notifications (kind, level, bot_id, thread_id, title, body, request_id, target_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.kind,
        levelFor(input.kind),
        input.botId,
        input.threadId,
        input.title,
        input.body,
        input.requestId ?? null,
        input.targetPersonId ?? null,
        now(),
      )
    const id = Number(result.lastInsertRowid)
    const seq = appendLog({ type: "notify", notificationId: id })
    return { notification: get(id) as NotificationRecord, seq }
  }

  const resolve = ({
    id,
    resolution,
  }: {
    id: number
    resolution: NotifyResolution
  }): { notification: NotificationRecord; seq: number } | null => {
    const result = db
      .query("UPDATE notifications SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL")
      .run(now(), resolution, id)
    if (result.changes === 0) return null
    const seq = appendLog({ type: "resolved", notificationId: id })
    return { notification: get(id) as NotificationRecord, seq }
  }

  const unresolvedForThread = ({
    threadId,
    kinds,
  }: {
    threadId: string
    kinds: ReadonlyArray<NotifyKind>
  }): Array<NotificationRecord> =>
    (db.query(`${SELECT} WHERE n.thread_id = ? AND n.resolved_at IS NULL`).all(threadId) as Array<Row>)
      .map(asRecord)
      .filter((record) => kinds.includes(record.kind))

  const pending = (): Array<NotificationRecord> => {
    const since = now() - BACKLOG_WINDOW_MS
    return (db.query(PENDING_NOTIFICATIONS_SQL).all(since) as Array<Row>).map(asRecord)
  }

  const getUnresolvedAttention = (): Array<NotificationRecord> =>
    (
      db
        .query(`${SELECT} WHERE n.resolved_at IS NULL
          AND n.kind IN (${[...ATTENTION_KINDS].map((kind) => `'${kind}'`).join(", ")}) ORDER BY n.id ASC`)
        .all() as Array<Row>
    ).map(asRecord)

  const recent = (limit: number): Array<NotificationRecord> =>
    (db.query(`${SELECT} ORDER BY n.id DESC LIMIT ?`).all(limit) as Array<Row>).map(asRecord)

  const getForPerson = (personId: string, notifications: ReadonlyArray<NotificationRecord>): NotificationRecord[] => {
    if (notifications.length === 0) return []

    const placeholders = notifications.map(() => "?").join(",")
    const statement = db.query(`SELECT notification_id, read_at FROM notification_reads
      WHERE person_id = ? AND notification_id IN (${placeholders})`)
    const personBindings: Array<string | number> = [personId]
    const bindings = personBindings.concat(notifications.map((item) => item.id))
    const receipts = statement.all.apply(statement, bindings) as Array<{ notification_id: number; read_at: number }>
    const readAtById = new Map(receipts.map((receipt) => [receipt.notification_id, receipt.read_at]))

    return notifications.map((item) => Object.assign({}, item, { readAt: readAtById.get(item.id) ?? null }))
  }

  const markRead = (personId: string, notifications: ReadonlyArray<NotificationRecord>): NotificationRecord[] => {
    const readAt = now()
    const insert = db.query(
      "INSERT OR IGNORE INTO notification_reads(person_id, notification_id, read_at) VALUES (?, ?, ?)",
    )
    db.transaction(() => {
      notifications.forEach((notification) => {
        insert.run(personId, notification.id, readAt)
      })
    })()

    return getForPerson(personId, notifications)
  }

  const lastSeq = (): number => {
    const row = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM notification_log").get() as { seq: number }
    return row.seq
  }

  const logSince = ({ since, limit = 1000 }: { since: number; limit?: number }): Array<LogEntry> => {
    const rows = db
      .query(
        `SELECT l.seq AS seq, l.type AS type, n.*, b.name AS bot_name, b.color AS bot_color, b.avatar_shape AS bot_avatar_shape, b.avatar_seed AS bot_avatar_seed
         FROM notification_log l JOIN notifications n ON n.id = l.notification_id
         LEFT JOIN bots b ON b.id = n.bot_id
         WHERE l.seq > ? ORDER BY l.seq ASC LIMIT ?`,
      )
      .all(since, limit) as Array<Row & { seq: number; type: "notify" | "resolved" }>
    const cutoff = now() - MESSAGE_REPLAY_MS
    return rows
      .map((row) => ({ seq: row.seq, type: row.type, notification: asRecord(row) }))
      .filter((entry) => !(MESSAGE_KINDS.has(entry.notification.kind) && entry.notification.createdAt < cutoff))
  }

  return {
    get,
    byRequestId,
    insert,
    resolve,
    unresolvedForThread,
    pending,
    getUnresolvedAttention,
    recent,
    getForPerson,
    markRead,
    lastSeq,
    logSince,
  }
}

export type NotificationStore = ReturnType<typeof createNotificationStore>
