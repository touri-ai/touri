import type { Database } from "bun:sqlite"
import type { MessagePart, UiEvent } from "@touri/contracts"
import { refreshMessageSearch } from "./message-search"

type Delta = Extract<UiEvent, { type: "message.delta" }>
type StreamEvent = Delta | Extract<UiEvent, { type: "message.parts" }>
type Projection = {
  id: string
  thread_id: string
  text: string
  parts_json: string
  updated_seq: number
  generation: number
  updated_at: number
}

type ProjectionTarget = { threadId: string; messageId: string }

const hasPartGap = (length: number, patches: Array<{ partIndex: number }>): boolean => {
  const appended = new Set<number>()
  let maximum = length - 1
  for (const { partIndex } of patches) {
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) return true
    if (partIndex < length) continue
    appended.add(partIndex)
    maximum = Math.max(maximum, partIndex)
  }
  return maximum - length + 1 !== appended.size
}

// Snapshots are mutable projections. The small, durable entries remain the source of
// uncheckpointed text, including after a crash. Publishing a projection adds no event.
export const materializeTranscriptBatch = (database: Database, threadId?: string): boolean =>
  database
    .transaction(() => {
      const filter = threadId ? "WHERE thread_id=?" : ""
      const statement = database.query(`SELECT thread_id,message_id FROM transcript_pending_deltas
      ${filter} ORDER BY thread_id,message_id LIMIT 1`)
      const pending = (threadId ? statement.get(threadId) : statement.get()) as {
        thread_id: string
        message_id: string
      } | null
      if (!pending) return false

      const target = { threadId: pending.thread_id, messageId: pending.message_id }
      const snapshot = database
        .query("SELECT updated_seq FROM messages WHERE thread_id=? AND id=?")
        .get(target.threadId, target.messageId) as { updated_seq: number } | null
      if (!snapshot) {
        clearPendingProjection(database, target)
        return true
      }
      const delta = database
        .query(`SELECT seq FROM transcript_entries INDEXED BY transcript_delta_message
      WHERE thread_id=? AND json_extract(event_json,'$.messageId')=?
        AND json_extract(event_json,'$.type')='message.delta' ORDER BY seq DESC LIMIT 1`)
        .get(target.threadId, target.messageId) as { seq: number } | null
      const part = database
        .query(`SELECT e.seq FROM transcript_part_entries part INDEXED BY transcript_part_message
      CROSS JOIN transcript_entries e WHERE part.thread_id=? AND part.message_id=?
        AND e.id=part.entry_id ORDER BY part.entry_id DESC LIMIT 1`)
        .get(target.threadId, target.messageId) as { seq: number } | null
      const head = Math.max(delta?.seq ?? 0, part?.seq ?? 0)
      if (head <= snapshot.updated_seq) {
        clearPendingProjection(database, target)
        return true
      }
      database.exec(`CREATE TEMP TABLE IF NOT EXISTS transcript_recovery_scan (
      thread_id TEXT NOT NULL,message_id TEXT NOT NULL,cursor INTEGER NOT NULL,
      PRIMARY KEY(thread_id,message_id)
    )`)
      const saved = database
        .query("SELECT cursor FROM transcript_recovery_scan WHERE thread_id=? AND message_id=?")
        .get(target.threadId, target.messageId) as { cursor: number } | null
      const cursor = Math.max(saved?.cursor ?? 0, snapshot.updated_seq)
      // Bound rows BEFORE JSON extraction/filtering or ordering. A LIMIT after
      // sorting both entire per-message streams would still read their full history.
      const rows = database
        .query(`SELECT id AS entry_id,seq AS delta_seq,at,? AS id,thread_id
      FROM transcript_entries WHERE thread_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 128`)
        .all(target.messageId, target.threadId, cursor, head) as Array<Omit<ProjectionEntry, "event_json">>
      // Local replay/cursor accumulators avoid materializing a window of legacy
      // full snapshots; one large historical body is fetched and released at a time.
      const relevant: ProjectionEntry[] = []
      const started = performance.now()
      let next = rows.length ? cursor : head
      for (const row of rows) {
        if (next !== cursor && performance.now() - started >= 8) break

        const body = database.query("SELECT event_json FROM transcript_entries WHERE id=?").get(row.entry_id) as {
          event_json: string
        }
        const event = JSON.parse(body.event_json) as { type: string; messageId?: string }
        next = row.delta_seq
        if (event.messageId !== target.messageId || (event.type !== "message.delta" && event.type !== "message.parts"))
          continue

        relevant.push({ ...row, event_json: body.event_json })
      }
      applyTranscriptEntries(database, relevant, target, next >= head)
      database
        .query(`INSERT INTO transcript_recovery_scan(thread_id,message_id,cursor) VALUES (?,?,?)
      ON CONFLICT(thread_id,message_id) DO UPDATE SET cursor=excluded.cursor`)
        .run(target.threadId, target.messageId, next)
      if (next >= head)
        database
          .query("DELETE FROM transcript_recovery_scan WHERE thread_id=? AND message_id=?")
          .run(target.threadId, target.messageId)
      return true
    })
    .immediate()

export const materializeTranscript = (database: Database, target?: ProjectionTarget): void => {
  if (!database.query("SELECT 1 FROM transcript_pending_deltas LIMIT 1").get()) return
  database
    .transaction(() => {
      const targetFilter = target ? "AND p.thread_id = ? AND p.message_id = ?" : ""
      const statement = database.query(
        // Drive both indexed stream lookups from the small dirty-message queue.
        `SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_pending_deltas p
         CROSS JOIN messages m
         CROSS JOIN transcript_entries e INDEXED BY transcript_delta_message
         WHERE m.thread_id = p.thread_id AND m.id = p.message_id
           ${targetFilter}
           AND e.thread_id = p.thread_id AND json_extract(e.event_json, '$.messageId') = p.message_id
           AND json_extract(e.event_json, '$.type') = 'message.delta' AND e.seq > m.updated_seq
         UNION ALL
         SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
         FROM transcript_pending_deltas p
         CROSS JOIN messages m
         CROSS JOIN transcript_part_entries part INDEXED BY transcript_part_message
         CROSS JOIN transcript_entries e
         WHERE m.thread_id = p.thread_id AND m.id = p.message_id
           ${targetFilter}
           AND part.thread_id = p.thread_id AND part.message_id = p.message_id
           AND e.id = part.entry_id AND e.seq > m.updated_seq
         ORDER BY entry_id`,
      )
      const rows = (
        target ? statement.all(target.threadId, target.messageId, target.threadId, target.messageId) : statement.all()
      ) as ProjectionEntry[]
      applyTranscriptEntries(database, rows, target)
    })
    .immediate()
}

type ProjectionEntry = {
  entry_id: number
  id: string
  thread_id: string
  delta_seq: number
  at: number
  event_json: string
}

const applyTranscriptEntries = (
  database: Database,
  rows: ProjectionEntry[],
  target?: ProjectionTarget,
  complete = true,
): void => {
  // Only private projection copies and the local accumulator change in this
  // replay loop; copying the growing text/parts for each delta would be quadratic.
  const projections = new Map<string, Projection & { parts: MessagePart[] }>()
  for (const row of rows) {
    const key = JSON.stringify([row.thread_id, row.id])
    let projection = projections.get(key)
    if (!projection) {
      const snapshot = database
        .query("SELECT * FROM messages WHERE thread_id = ? AND id = ?")
        .get(row.thread_id, row.id) as Projection
      projection = { ...snapshot, parts: JSON.parse(snapshot.parts_json) as MessagePart[] }
    }
    const event = JSON.parse(row.event_json) as StreamEvent
    if (event.type === "message.parts") {
      if (hasPartGap(projection.parts.length, event.parts)) throw new Error("Transcript part has a gap")
      for (const patch of event.parts) {
        projection.parts[patch.partIndex] = patch.part
      }
      projection.text = projection.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    } else {
      const part = projection.parts[event.partIndex]
      const text = part?.type === "text" || part?.type === "reasoning" ? part.text : ""
      if (event.offset === undefined || event.offset > text.length) throw new Error("Transcript delta has a gap")
      const suffix = event.delta.slice(Math.max(0, text.length - event.offset))
      const partType = event.partType ?? (part?.type === "reasoning" ? "reasoning" : "text")
      projection.parts[event.partIndex] = {
        ...(part?.type === partType ? part : {}),
        type: partType,
        text: text + suffix,
      }
      if (partType === "text") projection.text += suffix
    }
    projection.updated_seq = row.delta_seq
    projection.generation = event.generation ?? projection.generation
    projection.updated_at = row.at
    projections.set(key, projection)
  }
  if (!projections.size) {
    if (complete) clearPendingProjection(database, target)
    return
  }
  database.exec("UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1")
  for (const projection of projections.values()) {
    database
      .query(
        `UPDATE messages SET text = ?, parts_json = ?, updated_seq = ?, generation = ?, updated_at = ?
           WHERE thread_id = ? AND id = ?`,
      )
      .run(
        projection.text,
        JSON.stringify(projection.parts),
        projection.updated_seq,
        projection.generation,
        projection.updated_at,
        projection.thread_id,
        projection.id,
      )
    refreshMessageSearch(database, { threadId: projection.thread_id, id: projection.id, text: projection.text })
  }
  database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1")
  if (complete) clearPendingProjection(database, target)
}

const clearPendingProjection = (database: Database, target?: ProjectionTarget): void => {
  if (!target) {
    database.exec("DELETE FROM transcript_pending_deltas")
    return
  }

  database
    .query("DELETE FROM transcript_pending_deltas WHERE thread_id = ? AND message_id = ?")
    .run(target.threadId, target.messageId)
}

const hasPendingRetentionProjection = (database: Database, threadId: string, cutoff: number): boolean => {
  const delta = database
    .query(`SELECT 1 FROM transcript_pending_deltas p
    CROSS JOIN messages m CROSS JOIN transcript_entries e INDEXED BY transcript_delta_message
    WHERE p.thread_id = ? AND m.thread_id = p.thread_id AND m.id = p.message_id AND m.updated_seq < ?
      AND e.thread_id = p.thread_id AND json_extract(e.event_json, '$.messageId') = p.message_id
      AND json_extract(e.event_json, '$.type') = 'message.delta'
      AND e.seq > m.updated_seq AND e.seq <= ? LIMIT 1`)
    .get(threadId, cutoff, cutoff)
  if (delta) return true

  return Boolean(
    database
      .query(`SELECT 1 FROM transcript_pending_deltas p
    CROSS JOIN messages m CROSS JOIN transcript_part_entries part INDEXED BY transcript_part_message
    CROSS JOIN transcript_entries e
    WHERE p.thread_id = ? AND m.thread_id = p.thread_id AND m.id = p.message_id AND m.updated_seq < ?
      AND part.thread_id = p.thread_id AND part.message_id = p.message_id AND e.id = part.entry_id
      AND e.seq > m.updated_seq AND e.seq <= ? LIMIT 1`)
      .get(threadId, cutoff, cutoff),
  )
}

export const TRANSCRIPT_RETENTION = { events: 10_000, entriesPerThread: 2_000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }

export const botReplayRows = (database: Database, botId: string): Array<{ seq: number; event_json: string }> =>
  database
    .query(`SELECT seq,event_json FROM ui_event_log e WHERE EXISTS (
    SELECT 1 FROM json_tree(e.event_json) j WHERE
      (j.key IN ('botId','bot_id','ownerBotId','vmBotId') AND j.value = ?)
      OR (j.key IN ('threadId','thread_id','sourceThreadId','groupThreadId') AND j.value IN (SELECT id FROM threads WHERE bot_id=?))
      OR (j.fullkey = '$.bot.id' AND j.value=?)
      OR (j.fullkey = '$.thread.id' AND j.value IN (SELECT id FROM threads WHERE bot_id=?))
      OR (j.key = 'processId' AND j.value IN (SELECT id FROM processes WHERE vm_bot_id=?))
      OR (j.fullkey = '$.spec.id' AND j.value IN (SELECT id FROM processes WHERE vm_bot_id=?))
      OR (j.key = 'tabId' AND j.value IN (SELECT id FROM browser_tabs WHERE owner_bot_id=?))
  )`)
    .all(botId, botId, botId, botId, botId, botId, botId) as Array<{ seq: number; event_json: string }>

/** Called before removing the bot's thread rows, within the deletion transaction. */
export const purgeBotReplay = (database: Database, botId: string): void => {
  purgeReplayRows(database, botReplayRows(database, botId))
}

/** Called before removing owned rows, within the deletion transaction. */
export const purgeReplayRows = (database: Database, rows: Array<{ seq: number }>): void => {
  const floor = rows.reduce((maximum, row) => Math.max(maximum, row.seq), 0)
  if (!floor) return
  database.query("UPDATE transcript_maintenance SET ui_delete_before_seq=? WHERE id=1").run(floor)
  rows.forEach((row) => {
    database.query("DELETE FROM ui_event_log WHERE seq=?").run(row.seq)
  })
  database
    .query("UPDATE schema_meta SET value=CAST(MAX(CAST(value AS INTEGER),?) AS TEXT) WHERE key='ui_event_floor_seq'")
    .run(floor)
  database.exec("UPDATE transcript_maintenance SET ui_delete_before_seq=0 WHERE id=1")
}

type RetentionOptions = {
  database: Database
  events?: number
  entriesPerThread?: number
  maxAgeMs?: number
  now?: number
}
type RetentionRow = { id: number; seq: number; bytes: number }
type RetentionThread = { threadId: string; cutoff: number; rows: RetentionRow[] }
type EventRetentionScan = {
  events: number
  floor: number
  head: number
  before: number
  remaining: number
  cutoff: number
  complete: boolean
}
export type TranscriptRetentionPlan = {
  checkpoint: number
  threads: RetentionThread[]
  events: Array<{ seq: number; bytes: number }>
  eventScan: EventRetentionScan
  nextCursor: number
  more: boolean
}

/** Synchronous entry point for offline maintenance and synthetic equivalence checks. */
export const compactTranscript = (options: RetentionOptions): boolean => {
  const { database } = options
  database.exec(`CREATE TEMP TABLE IF NOT EXISTS transcript_retention_cursor (
    id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL
  ); INSERT OR IGNORE INTO transcript_retention_cursor VALUES (1,0)`)
  const { cursor } = database.query("SELECT cursor FROM transcript_retention_cursor WHERE id=1").get() as {
    cursor: number
  }
  const plan = getTranscriptRetentionPlan(options, cursor)
  if (!plan) return false

  const result = applyTranscriptRetentionPlan(database, plan)
  database.query("UPDATE transcript_retention_cursor SET cursor=? WHERE id=1").run(result.cursor)
  return result.more
}

/** Discover candidates BEFORE acquiring the writer slot. Live callers use the isolated helper. */
export const getTranscriptRetentionPlan = (
  {
    database,
    events = TRANSCRIPT_RETENTION.events,
    entriesPerThread = TRANSCRIPT_RETENTION.entriesPerThread,
    maxAgeMs = TRANSCRIPT_RETENTION.maxAgeMs,
    now = Date.now(),
  }: RetentionOptions,
  cursor: number,
  limit = 256,
  byteLimit = 256 * 1024,
): TranscriptRetentionPlan | undefined => {
  if (isRetentionUpgradePending(database)) return undefined

  const checkpoint = Number(
    (database.query("SELECT value FROM schema_meta WHERE key='transcript_event_checkpoint'").get() as { value: string })
      .value,
  )
  const aged = database
    .query(`SELECT thread_id,seq,id FROM transcript_entries INDEXED BY transcript_entries_age
      WHERE at < ? ORDER BY at,id LIMIT ?`)
    .all(now - maxAgeMs, limit) as Array<{ thread_id: string; seq: number; id: number }>
  // This bounded, private map combines age and count cutoffs for the same thread.
  const cutoffs = new Map<string, number>()
  aged
    .filter((row) => row.id <= checkpoint)
    .forEach((row) => {
      cutoffs.set(row.thread_id, Math.max(cutoffs.get(row.thread_id) ?? 0, row.seq))
    })
  const thread = database
    .query("SELECT rowid AS cursor,id,updated_seq FROM threads WHERE rowid > ? ORDER BY rowid LIMIT 1")
    .get(cursor) as { cursor: number; id: string; updated_seq: number } | null
  if (thread && thread.updated_seq > entriesPerThread) {
    const excess = database
      .query("SELECT seq,id FROM transcript_entries WHERE thread_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?")
      .get(thread.id, entriesPerThread) as { seq: number; id: number } | null
    if (excess && excess.id <= checkpoint) cutoffs.set(thread.id, Math.max(cutoffs.get(thread.id) ?? 0, excess.seq))
  }
  // Row and byte budgets are local accumulators; no historical body leaves this process.
  let remainingRows = limit
  let remainingBytes = byteLimit
  let more = false
  let transcriptBudgetExhausted = false
  const threads = Array.from(cutoffs).map(([threadId, cutoff]): RetentionThread => {
    const candidates = database
      .query(`SELECT id,seq,length(CAST(event_json AS BLOB)) AS bytes FROM transcript_entries
        WHERE thread_id=? AND seq<=? AND id<=? ORDER BY seq LIMIT ?`)
      .all(threadId, cutoff, checkpoint, remainingRows) as RetentionRow[]
    const rows = candidates.filter((row) => {
      // One indivisible legacy row may exceed the byte budget. The helper's write deadline still applies.
      if (transcriptBudgetExhausted) return false
      if (remainingRows <= 0 || (row.bytes > remainingBytes && remainingRows < limit)) {
        transcriptBudgetExhausted = true
        return false
      }
      remainingRows -= 1
      remainingBytes -= row.bytes
      return true
    })
    if (rows.length < candidates.length || remainingRows === 0 || remainingBytes <= 0) more = true
    return { threadId, cutoff, rows }
  })
  const eventScan = getEventRetentionScan(database, events)
  const agedEvents = database
    .query(`SELECT seq FROM ui_event_log INDEXED BY ui_event_log_age WHERE at < ? ORDER BY at,seq LIMIT ?`)
    .all(now - maxAgeMs, limit) as Array<{ seq: number }>
  const cutoff = eventScan.complete
    ? agedEvents.reduce((maximum, row) => Math.max(maximum, row.seq), eventScan.cutoff)
    : 0
  const candidates = database
    .query("SELECT seq,length(CAST(event_json AS BLOB)) AS bytes FROM ui_event_log WHERE seq<=? ORDER BY seq LIMIT ?")
    .all(cutoff, limit) as Array<{ seq: number; bytes: number }>
  let eventBytes = 0
  let eventBudgetExhausted = false
  const eventRows = candidates.filter((row) => {
    if (eventBudgetExhausted) return false
    if (eventBytes > 0 && eventBytes + row.bytes > byteLimit) {
      eventBudgetExhausted = true
      return false
    }
    eventBytes += row.bytes
    return true
  })

  const eventsMore = eventRows.length < candidates.length || candidates.length === limit

  return {
    checkpoint,
    threads,
    events: eventRows,
    eventScan,
    nextCursor: thread?.cursor ?? 0,
    more: more || !eventScan.complete || eventsMore,
  }
}

export const applyTranscriptRetentionPlan = (
  database: Database,
  plan: TranscriptRetentionPlan,
): { more: boolean; cursor: number } =>
  database
    .transaction(() => {
      if (isRetentionUpgradePending(database)) return { more: false, cursor: 0 }

      // A bot purge can remove already-counted tail rows while discovery yields.
      if (getEventRetentionFloor(database) !== plan.eventScan.floor)
        return { more: true, cursor: plan.nextCursor ? plan.nextCursor - 1 : 0 }

      // A projection can become dirty while discovery yields; revalidate under the writer lock.
      const pending = plan.threads.find(({ threadId, cutoff }) =>
        hasPendingRetentionProjection(database, threadId, cutoff),
      )
      if (pending) {
        materializeRetentionProjection(database, pending.threadId)
        return { more: true, cursor: plan.nextCursor ? plan.nextCursor - 1 : 0 }
      }
      const checkpoint = Math.min(
        plan.checkpoint,
        Number(
          (
            database.query("SELECT value FROM schema_meta WHERE key='transcript_event_checkpoint'").get() as {
              value: string
            }
          ).value,
        ),
      )
      const started = performance.now()
      const transcriptMore = plan.threads
        .map((thread) => deleteTranscriptRetentionPrefix(database, thread, checkpoint, started))
        .some(Boolean)
      const eventMore = deleteEventRetentionPrefix(database, plan.events)
      saveEventRetentionScan(database, plan.eventScan)
      const more = plan.more || transcriptMore || eventMore
      database.exec("UPDATE transcript_maintenance SET delete_before_id=0,ui_delete_before_seq=0 WHERE id=1")
      const cursor = more && plan.nextCursor ? plan.nextCursor - 1 : plan.nextCursor
      return { more: more || plan.nextCursor > 0, cursor }
    })
    .immediate()

const eventRetentionScanKey = "event_retention_scan"
const eventRetentionScanLimit = 1024

const getEventRetentionScan = (database: Database, events: number): EventRetentionScan => {
  const floor = getEventRetentionFloor(database)
  const saved = getSavedEventRetentionScan(database)
  const head = database.query("SELECT seq FROM sqlite_sequence WHERE name='ui_event_log'").get() as {
    seq: number
  } | null
  const initial: EventRetentionScan = {
    events,
    floor,
    head: head?.seq ?? 0,
    before: head?.seq ?? 0,
    remaining: events,
    cutoff: 0,
    complete: false,
  }
  const hasNewTail = saved?.complete && saved.cutoff <= floor && saved.head !== initial.head
  const scan = saved?.events === events && saved.floor === floor && !hasNewTail ? saved : initial
  if (scan.complete) return scan

  // Seek from the last committed page; OFFSET repeatedly walks cold payload pages.
  // Count actual rows, since purges leave gaps and sequence subtraction would lose history.
  const limit = Math.min(eventRetentionScanLimit, scan.remaining + 1)
  const rows = database
    .query("SELECT seq FROM ui_event_log WHERE seq<=? ORDER BY seq DESC LIMIT ?")
    .all(scan.before, limit) as Array<{ seq: number }>
  const cutoff = rows[scan.remaining]?.seq ?? 0
  const last = rows.at(-1)

  return {
    events,
    floor,
    head: scan.head,
    before: Math.max(0, (last?.seq ?? 1) - 1),
    remaining: Math.max(0, scan.remaining - rows.length),
    cutoff,
    complete: cutoff > 0 || rows.length < limit,
  }
}

const getEventRetentionFloor = (database: Database): number =>
  Number(
    (database.query("SELECT value FROM schema_meta WHERE key='ui_event_floor_seq'").get() as { value: string }).value,
  )

const getSavedEventRetentionScan = (database: Database): EventRetentionScan | undefined => {
  const row = database.query("SELECT value FROM schema_meta WHERE key=?").get(eventRetentionScanKey) as {
    value: string
  } | null
  if (!row || row.value.length > 4096) return undefined

  try {
    const scan = JSON.parse(row.value) as EventRetentionScan
    const counts = [scan.events, scan.floor, scan.head, scan.before, scan.remaining, scan.cutoff]
    if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return undefined
    if (scan.remaining > scan.events || typeof scan.complete !== "boolean") return undefined

    return scan
  } catch {
    return undefined
  }
}

const saveEventRetentionScan = (database: Database, scan: EventRetentionScan): void => {
  const next = { ...scan, floor: getEventRetentionFloor(database) }
  database
    .query(`INSERT INTO schema_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(eventRetentionScanKey, JSON.stringify(next))
}

type RetentionProjectionScan = {
  threadId: string
  messageId: string
  snapshotSeq: number
  generation: number
  cursor: number
}
const retentionProjectionScanKey = "transcript_retention_projection_scan"

const materializeRetentionProjection = (database: Database, threadId: string): void => {
  const target = database
    .query(`SELECT p.message_id,m.updated_seq,m.generation FROM transcript_pending_deltas p
    LEFT JOIN messages m ON m.thread_id=p.thread_id AND m.id=p.message_id
    WHERE p.thread_id=? ORDER BY p.message_id LIMIT 1`)
    .get(threadId) as {
    message_id: string
    updated_seq: number | null
    generation: number | null
  } | null
  if (!target) return

  database.exec(`CREATE TEMP TABLE IF NOT EXISTS transcript_recovery_scan (
    thread_id TEXT NOT NULL,message_id TEXT NOT NULL,cursor INTEGER NOT NULL,
    PRIMARY KEY(thread_id,message_id)
  )`)
  const saved = getRetentionProjectionScan(database)
  if (
    saved &&
    saved.threadId === threadId &&
    saved.messageId === target.message_id &&
    saved.snapshotSeq === target.updated_seq &&
    saved.generation === target.generation
  )
    database
      .query(`INSERT INTO temp.transcript_recovery_scan(thread_id,message_id,cursor) VALUES(?,?,?)
      ON CONFLICT(thread_id,message_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`)
      .run(threadId, target.message_id, saved.cursor)

  materializeTranscriptBatch(database, threadId)
  const progress = database
    .query(`SELECT scan.cursor,m.updated_seq,m.generation FROM temp.transcript_recovery_scan scan
    JOIN messages m ON m.thread_id=scan.thread_id AND m.id=scan.message_id
    WHERE scan.thread_id=? AND scan.message_id=?`)
    .get(threadId, target.message_id) as {
    cursor: number
    updated_seq: number
    generation: number
  } | null
  if (!progress) {
    database.query("DELETE FROM schema_meta WHERE key=?").run(retentionProjectionScanKey)
    return
  }
  // The durable marker and its snapshot commit together, so a fresh helper can resume through unrelated entries.
  const next: RetentionProjectionScan = {
    threadId,
    messageId: target.message_id,
    snapshotSeq: progress.updated_seq,
    generation: progress.generation,
    cursor: progress.cursor,
  }
  database
    .query(`INSERT INTO schema_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(retentionProjectionScanKey, JSON.stringify(next))
}

const getRetentionProjectionScan = (database: Database): RetentionProjectionScan | undefined => {
  const row = database.query("SELECT value FROM schema_meta WHERE key=?").get(retentionProjectionScanKey) as {
    value: string
  } | null
  if (!row || row.value.length > 4096) return undefined

  try {
    const scan = JSON.parse(row.value) as RetentionProjectionScan
    if (
      typeof scan.threadId !== "string" ||
      typeof scan.messageId !== "string" ||
      !Number.isSafeInteger(scan.snapshotSeq) ||
      scan.snapshotSeq < 0 ||
      !Number.isSafeInteger(scan.generation) ||
      scan.generation < 0 ||
      !Number.isSafeInteger(scan.cursor) ||
      scan.cursor < scan.snapshotSeq
    )
      return undefined
    return scan
  } catch {
    return undefined
  }
}

const deleteTranscriptRetentionPrefix = (
  database: Database,
  { threadId, rows }: RetentionThread,
  checkpoint: number,
  started: number,
): boolean => {
  // Only the committed prefix advances; these accumulators belong to one bounded transaction.
  let through = 0
  let more = false
  for (const row of rows) {
    if (performance.now() - started >= 8) {
      more = true
      break
    }
    if (row.id > checkpoint) continue

    database.query("UPDATE transcript_maintenance SET delete_before_id=? WHERE id=1").run(row.id)
    database.query("DELETE FROM transcript_entries WHERE id=?").run(row.id)
    database.query("DELETE FROM rejections WHERE thread_id=? AND seq=?").run(threadId, row.seq)
    through = row.seq
  }
  if (through)
    database
      .query(`INSERT INTO transcript_retention(thread_id,through_seq) VALUES (?,?)
      ON CONFLICT(thread_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)`)
      .run(threadId, through)
  return more
}

const deleteEventRetentionPrefix = (database: Database, rows: TranscriptRetentionPlan["events"]): boolean => {
  const started = performance.now()
  // A slow last row is still protected by the helper's independent writer deadline.
  let through = 0
  let more = false
  for (const row of rows) {
    if (through && performance.now() - started >= 8) {
      more = true
      break
    }

    database.query("UPDATE transcript_maintenance SET ui_delete_before_seq=? WHERE id=1").run(row.seq)
    database.query("DELETE FROM ui_event_log WHERE seq=?").run(row.seq)
    through = row.seq
  }
  if (through)
    database
      .query("UPDATE schema_meta SET value=MAX(CAST(value AS INTEGER),?) WHERE key='ui_event_floor_seq'")
      .run(through)
  return more
}

const isRetentionUpgradePending = (database: Database): boolean =>
  Boolean(database.query("SELECT 1 FROM schema_meta WHERE key='storage_upgrade_22' AND value<>'done'").get())
