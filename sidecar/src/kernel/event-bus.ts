import type { Database } from "bun:sqlite"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"
import type { ServerWebSocket } from "bun"
import { boundedProcessLog } from "./output-blobs"
import type { PerformanceStage, PerformanceStageRunner } from "./performance"
import { captureTranscript as captureEntries, type TranscriptRef } from "./transcript-events"
import { compactTranscript, materializeTranscript } from "./transcript-storage"

export type EventSocketData = { channel: "events"; since?: number }
export type EventFilter = (event: UiEvent) => boolean

/** A reconnect replays at most this much; a larger gap is cheaper to reload over REST. */
export const REPLAY_LIMITS = { events: 2_000, bytes: 2 * 1024 * 1024 }
export const LIVE_DELIVERY_LIMITS = { events: 32, budgetMs: 8 }
const isSqliteBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))

type MessageRef = TranscriptRef
const isMessageRef = (value: unknown): value is MessageRef =>
  typeof value === "object" && value !== null && (value as { ref?: unknown }).ref === true
const messageKey = (event: UiEvent): string | null =>
  event.type === "message.created" || event.type === "message.updated"
    ? JSON.stringify([event.message.threadId, event.message.id])
    : null

type EventSocket = Pick<ServerWebSocket<unknown>, "readyState" | "sendText"> &
  Partial<Pick<ServerWebSocket<unknown>, "close">>
export const createEventBus = (
  database?: Database,
  runStage?: PerformanceStageRunner,
  {
    now = performance.now.bind(performance),
    schedule = scheduleDelivery,
    deferRecovery = false,
  }: DeliveryScheduling = {},
) => {
  const measureStage = <Value, Input>(stage: PerformanceStage, action: (input: Input) => Value, input: Input): Value =>
    runStage ? runStage(stage, action, input) : action(input)
  let sequence = 0
  const listeners = new Set<(envelope: UiEventEnvelope) => void>()
  let sockets: Array<{ socket: EventSocket; since: number; filter?: EventFilter }> = []
  let delivered = Number(
    (database?.query("SELECT seq FROM sqlite_sequence WHERE name = 'ui_event_log'").get() as { seq: number } | null)
      ?.seq ?? 0,
  )
  let scheduled = false
  let cancelContinuation: (() => void) | undefined
  let stopped = false
  let flushing = false
  let compactedAt = delivered
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  let captureRetryTimer: ReturnType<typeof setTimeout> | undefined
  let captureRetryAttempt = 0
  const serialize = (envelope: UiEventEnvelope): string =>
    JSON.stringify(envelope.event.type === "transcript.resync" ? { type: "resync", lastSeq: envelope.seq } : envelope)
  const payloadFor = (envelope: UiEventEnvelope): string =>
    measureStage("workspace_event_serialization", serialize, envelope)

  const removeSocket = (socket: EventSocket): void => {
    sockets = sockets.filter((entry) => entry.socket !== socket)
  }

  const broadcast = ({ payload, seq, event }: { payload: string; seq: number; event: UiEvent }): void => {
    sockets.forEach(({ socket, since, filter }) => {
      if (seq <= since) return
      if (filter && !filter(event)) return

      try {
        if (socket.readyState !== 1 || socket.sendText(payload) === 0) {
          removeSocket(socket)
          socket.close?.(1013, "Tente reconectar")
        }
      } catch {
        // A window reload must not interrupt persistence or other subscribers.
        removeSocket(socket)
      }
    })
  }

  const deliverNow = (envelope: UiEventEnvelope): void => {
    listeners.forEach((listener) => {
      try {
        listener(envelope)
      } catch {
        // A subscriber must not turn a committed write into a failed request.
      }
    })
    if (!sockets.some(({ since }) => envelope.seq > since)) return

    const payload = payloadFor(envelope)
    measureStage("workspace_websocket_broadcast", broadcast, { payload, seq: envelope.seq, event: envelope.event })
  }
  const deliver = (envelope: UiEventEnvelope): void => measureStage("workspace_event_delivery", deliverNow, envelope)

  const scheduleCaptureRetry = (): void => {
    if (stopped || captureRetryTimer) return
    const delayMs = Math.min(1_000, 50 * 2 ** Math.min(captureRetryAttempt, 4))
    captureRetryAttempt += 1
    captureRetryTimer = setTimeout(() => {
      captureRetryTimer = undefined
      captureTranscript()
    }, delayMs)
    captureRetryTimer.unref()
  }

  // Also recovers a committed tail whose publisher stopped before delivery.
  const captureTranscript = (): void => {
    if (!database || stopped) return
    const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    database.exec("PRAGMA busy_timeout = 0")
    try {
      measureStage("transcript_journal_capture", captureEntries, database)
      captureRetryAttempt = 0
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
      scheduleCaptureRetry()
    } finally {
      database.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
    }
  }

  const scheduleRetention = (): void => {
    if (stopped || retentionTimer) return
    retentionTimer = setTimeout(() => {
      retentionTimer = undefined
      runRetentionMaintenance(true)
    }, 100)
    retentionTimer.unref()
  }

  const runRetentionMaintenance = (force = false): void => {
    const currentDatabase = database
    if (!currentDatabase || stopped || (!force && delivered - compactedAt < 256)) return

    const timeout = (currentDatabase.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    currentDatabase.exec("PRAGMA busy_timeout = 0")
    const getMore = (): boolean | undefined => {
      try {
        return measureStage("transcript_retention", compactTranscript, { database: currentDatabase })
      } catch (error) {
        if (!isSqliteBusy(error)) throw error
        return undefined
      } finally {
        currentDatabase.exec(`PRAGMA busy_timeout = ${timeout}`)
      }
    }
    const more = getMore()
    if (more === undefined) {
      scheduleRetention()
      return
    }

    compactedAt = delivered
    if (more) scheduleRetention()
  }

  const getRefEvent = (event: MessageRef): UiEvent => {
    if (!database) return { type: "transcript.superseded" }
    const entry = database
      .query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
      .get(event.threadId, event.seq) as { event_json: string } | null
    const revision = entry ? (JSON.parse(entry.event_json) as UiEvent | MessageRef) : null
    if (
      !isMessageRef(revision) &&
      (revision?.type === "message.created" || revision?.type === "message.updated") &&
      revision.message.id === event.messageId
    )
      return revision
    if (event.type === "message.delta" || event.type === "message.parts") {
      if (
        !isMessageRef(revision) &&
        (revision?.type === "message.delta" || revision?.type === "message.parts") &&
        revision.messageId === event.messageId
      )
        return revision
      return { type: "transcript.resync" }
    }
    // Retention removed that revision: the current projection is newer and supersedes it.
    const current = database
      .query("SELECT payload FROM transcript_message_events WHERE thread_id = ? AND id = ?")
      .get(event.threadId, event.messageId) as { payload: string } | null
    return current
      ? ({ type: event.type, ...JSON.parse(current.payload) } as UiEvent)
      : { type: "transcript.superseded" }
  }
  const getHydratedRef = (event: MessageRef): UiEvent => measureStage("workspace_snapshot", getRefEvent, event)

  const hydrate = (raw: string): UiEvent => {
    const event = JSON.parse(raw) as UiEvent | MessageRef
    return isMessageRef(event) ? getHydratedRef(event) : event
  }

  const head = (): number =>
    (database?.query("SELECT seq FROM sqlite_sequence WHERE name = 'ui_event_log'").get() as { seq: number } | null)
      ?.seq ?? 0

  type Row = { seq: number; at: number; event_json: string }
  const getEventFloor = (): number =>
    Number(
      (
        database?.query("SELECT value FROM schema_meta WHERE key = 'ui_event_floor_seq'").get() as
          | { value: string }
          | undefined
      )?.value ?? 0,
    )

  /** The stored rows after `since`, or null when that cursor is outside the retained log. */
  const getRowsAfter = (since: number, limit = -1): Array<Row> | null => {
    if (!database) return []
    if (since < getEventFloor() || since > head()) return null
    return database
      .query("SELECT seq, at, event_json FROM ui_event_log WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(since, limit) as Array<Row>
  }

  const replay = (since: number): Array<UiEventEnvelope> => {
    const rows = getRowsAfter(since)
    if (!rows) return [{ seq: head(), at: Date.now(), event: { type: "transcript.resync" } }]
    return rows.map((row) => ({ seq: row.seq, at: row.at, event: hydrate(row.event_json) }))
  }

  /**
   * What a (re)connecting socket receives before live delivery. A cold client (since 0) and a
   * gap larger than REPLAY_LIMITS get one resync frame and reload over REST: streaming a long
   * history through the socket overran its send buffer and kept the UI minutes behind live
   * events. Within a gap, each message is sent once, at its first position, in its latest
   * revision; later revisions become no-ops so `seq` stays contiguous. Only that latest
   * revision is read back from the transcript, and an oversized gap is refused before its
   * bodies are read.
   */
  const catchUp = (since: number): Array<UiEventEnvelope> => {
    const resync = (): Array<UiEventEnvelope> => [{ seq: head(), at: Date.now(), event: { type: "transcript.resync" } }]
    if (!database || since === 0) return resync()
    const pending = database
      .query("SELECT seq FROM ui_event_log WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(since, REPLAY_LIMITS.events + 1)
    if (pending.length > REPLAY_LIMITS.events) return resync()
    const rows = getRowsAfter(since, REPLAY_LIMITS.events + 1)
    if (!rows || rows.length > REPLAY_LIMITS.events) return resync()
    const stored = rows.map((row) => JSON.parse(row.event_json) as UiEvent | MessageRef)
    const keyOf = (event: UiEvent | MessageRef): string | null =>
      isMessageRef(event)
        ? event.type === "message.created" || event.type === "message.updated"
          ? JSON.stringify([event.threadId, event.messageId])
          : null
        : messageKey(event)
    const latest = new Map<string, number>()
    stored.forEach((event, index) => {
      const key = keyOf(event)
      if (key) latest.set(key, index)
    })
    const sent = new Set<string>()
    const coalesced: Array<UiEventEnvelope> = []
    let bytes = 0
    for (const [index, row] of rows.entries()) {
      const value = stored[index] as UiEvent | MessageRef
      const key = keyOf(value)
      let event: UiEvent
      if (!key) event = isMessageRef(value) ? getHydratedRef(value) : (value as UiEvent)
      else if (sent.has(key)) event = { type: "transcript.superseded" }
      else {
        sent.add(key)
        const newest = stored[latest.get(key) ?? index] as UiEvent | MessageRef
        const revision = isMessageRef(newest) ? getHydratedRef(newest) : newest
        event =
          revision.type === "message.created" || revision.type === "message.updated"
            ? { type: value.type as "message.created" | "message.updated", message: revision.message }
            : { type: "transcript.superseded" }
      }
      if (event.type === "transcript.resync") return resync()
      const envelope = { seq: row.seq, at: row.at, event }
      bytes += payloadFor(envelope).length
      if (bytes > REPLAY_LIMITS.bytes) return resync()
      coalesced.push(envelope)
    }
    return coalesced
  }
  const scheduleFlush = (initial = false): void => {
    if (scheduled || stopped) return

    scheduled = true
    cancelContinuation = initial ? scheduleCommittedDelivery(flush) : schedule(flush)
  }

  const flush = (): void => {
    scheduled = false
    cancelContinuation = undefined
    if (!database || stopped || flushing) return

    flushing = true
    const startedAt = now()
    try {
      // Reentrant control notifications share this same bounded budget.
      let deliveredCount = 0
      while (!stopped && deliveredCount < LIVE_DELIVERY_LIMITS.events) {
        const pending = measureStage(
          "transcript_event_replay",
          (since) => getRowsAfter(since, LIVE_DELIVERY_LIMITS.events - deliveredCount),
          delivered,
        )
        if (!pending) {
          // Retention can advance while delivery yields. Preserve the retained tail for local subscribers.
          delivered = Math.min(head(), Math.max(delivered, getEventFloor()))
          deliver({ seq: delivered, at: Date.now(), event: { type: "transcript.resync" } })
          break
        }
        if (!pending.length) break

        for (const row of pending) {
          if (stopped) break

          const envelope = { seq: row.seq, at: row.at, event: hydrate(row.event_json) }
          delivered = envelope.seq
          deliveredCount += 1
          deliver(envelope)
          if (now() - startedAt >= LIVE_DELIVERY_LIMITS.budgetMs) break
        }
        if (now() - startedAt >= LIVE_DELIVERY_LIMITS.budgetMs) break
      }
    } finally {
      flushing = false
      if (!stopped && delivered < head()) scheduleFlush()
    }
    if (stopped || delivered < head() || delivered - compactedAt < 256) return

    runRetentionMaintenance()
  }
  const writeEvent = (event: UiEvent): void => {
    database
      ?.query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)")
      .run(Date.now(), JSON.stringify(event.type === "process.log" ? boundedProcessLog(event) : event))
  }
  const publish = (event: UiEvent): void => {
    if (stopped) return
    if (!database) {
      deliver({ seq: ++sequence, at: Date.now(), event })
      return
    }
    captureTranscript()
    if (
      !(
        (event.type === "message.created" || event.type === "message.updated") &&
        event.message.updatedSeq !== undefined
      ) &&
      !((event.type === "message.delta" || event.type === "message.parts") && event.updatedSeq !== undefined) &&
      event.type !== "transcript.rejected"
    )
      measureStage("transcript_event_log_write", writeEvent, event)
    if (database.inTransaction) {
      scheduleFlush(true)
      return
    }
    if (!scheduled) flush()
  }
  if (!deferRecovery) {
    captureTranscript()
    if (database) materializeTranscript(database)
  }

  return {
    publish,
    subscribe: (listener: (envelope: UiEventEnvelope) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    add: (socket: EventSocket, since = 0, filter?: EventFilter): void => {
      captureTranscript()
      if (!scheduled) flush()
      if (database) {
        runRetentionMaintenance(true)
        for (const envelope of catchUp(since)) {
          if (filter && !filter(envelope.event)) continue
          if (socket.sendText(payloadFor(envelope)) === 0) {
            socket.close?.(1013, "Tente reconectar")
            return
          }
        }
      }
      const sinceHead = database ? head() : sequence
      sockets = sockets.concat({ socket, since: sinceHead, ...(filter ? { filter } : {}) })
    },
    remove: (socket: EventSocket): void => {
      removeSocket(socket)
    },
    replay,
    catchUp,
    stop: (): void => {
      stopped = true
      cancelContinuation?.()
      clearTimeout(retentionTimer)
      clearTimeout(captureRetryTimer)
      sockets = []
    },
  }
}

type DeliveryScheduling = {
  now?: () => number
  schedule?: (action: () => void) => () => void
  deferRecovery?: boolean
}

const scheduleDelivery = (action: () => void): (() => void) => {
  const timer = setImmediate(action)

  return () => clearImmediate(timer)
}

const scheduleCommittedDelivery = (action: () => void): (() => void) => {
  // Keep post-commit notification ordering. Only the first bounded batch is a microtask;
  // a backlog always continues through setImmediate so timers, I/O and cancellation can run.
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) action()
  })

  return () => {
    cancelled = true
  }
}
