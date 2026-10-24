import type { Database } from "bun:sqlite"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"
import type { ServerWebSocket } from "bun"
import { createStoreReader } from "../store/reader"
import { onDatabaseCommit } from "./database-write"
import { getRefEvent, isMessageRef } from "./event-reference"
import { boundedProcessLog } from "./output-blobs"
import type { PerformanceStage, PerformanceStageRunner } from "./performance"
import { captureTranscript as captureEntries, type TranscriptRef } from "./transcript-events"
import { createTranscriptRetention } from "./transcript-retention"
import { materializeTranscript } from "./transcript-storage"

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

const isControlEvent = (event: UiEvent): boolean =>
  !event.type.startsWith("message.") && !event.type.startsWith("transcript.")

type MessageRef = TranscriptRef
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
    getReferenceEvents,
  }: DeliveryScheduling = {},
) => {
  const measureStage = <Value, Input>(stage: PerformanceStage, action: (input: Input) => Value, input: Input): Value =>
    runStage ? runStage(stage, action, input) : action(input)
  let sequence = 0
  // Track early callbacks individually: a later publication cannot supersede an older committed control.
  const earlyControls = new Set<number>()
  const listeners = new Set<(envelope: UiEventEnvelope) => void>()
  const runtimeListeners = new Set<(envelope: UiEventEnvelope) => void>()
  let sockets: SocketEntry[] = []
  const reader = database ? createStoreReader(database.filename) : undefined
  const shutdown = new AbortController()
  const readReferences = getReferenceEvents ?? reader?.getReferenceEvents
  const getReferences = readReferences
    ? (references: TranscriptRef[], signal: AbortSignal, maxBytes?: number) =>
        measureStage("workspace_snapshot", () => readReferences(references, signal, maxBytes), undefined)
    : undefined
  let liveRead: { key: string | undefined; abort: AbortController } | undefined
  let publications: Array<{ key: string; event: UiEvent; bytes: number; through: number }> = []
  let readRetryTimer: ReturnType<typeof setTimeout> | undefined
  let delivered = Number(
    (database?.query("SELECT seq FROM sqlite_sequence WHERE name = 'ui_event_log'").get() as { seq: number } | null)
      ?.seq ?? 0,
  )
  let scheduled = false
  let cancelContinuation: (() => void) | undefined
  let stopped = false
  let flushing = false
  const retention = database ? createTranscriptRetention(database) : undefined
  let retentionRunning = false
  let compactedAt = delivered
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  let captureRetryTimer: ReturnType<typeof setTimeout> | undefined
  let captureRetryAttempt = 0
  const serialize = (envelope: UiEventEnvelope): string =>
    JSON.stringify(envelope.event.type === "transcript.resync" ? { type: "resync", lastSeq: envelope.seq } : envelope)
  const payloadFor = (envelope: UiEventEnvelope): string =>
    measureStage("workspace_event_serialization", serialize, envelope)

  const removeSocket = (socket: EventSocket): void => {
    sockets
      .filter((entry) => entry.socket === socket)
      .forEach((entry) => {
        entry.replay?.abort.abort()
      })
    sockets = sockets.filter((entry) => entry.socket !== socket)
  }

  const broadcast = ({ payload, seq, event }: { payload: string; seq: number; event: UiEvent }): void => {
    sockets.forEach(({ socket, since, filter, replay }) => {
      if (seq <= since) return
      // Keep the cursor contiguous without exposing an event denied to this viewer.
      const visiblePayload =
        filter && !filter(event) ? payloadFor({ seq, at: 0, event: { type: "transcript.superseded" } }) : payload

      // The per-socket streaming buffer is bounded while its historical read is in flight.
      if (replay) {
        if (replay.overflow) return
        replay.bytes += Buffer.byteLength(payload)
        if (replay.payloads.length >= REPLAY_LIMITS.events || replay.bytes > REPLAY_LIMITS.bytes) {
          replay.overflow = true
          replay.payloads = []
          return
        }
        replay.payloads = replay.payloads.concat({ payload: visiblePayload, seq, event })
        return
      }

      try {
        if (socket.readyState !== 1 || socket.sendText(visiblePayload) === 0) {
          removeSocket(socket)
          socket.close?.(1013, "Tente reconectar")
        }
      } catch {
        // A window reload must not interrupt persistence or other subscribers.
        removeSocket(socket)
      }
    })
  }

  const notifyListeners = (envelope: UiEventEnvelope, immediate = false): void => {
    const targets = immediate ? runtimeListeners : listeners
    targets.forEach((listener) => {
      try {
        listener(envelope)
      } catch {
        // A subscriber must not turn a committed write into a failed request.
      }
    })
  }

  const deliverNow = (envelope: UiEventEnvelope): void => {
    notifyListeners(envelope)
    if (!isControlEvent(envelope.event) || !earlyControls.delete(envelope.seq)) {
      notifyListeners(envelope, true)
    }
    if (!sockets.some(({ since }) => envelope.seq > since)) return

    const payload = payloadFor(envelope)
    measureStage("workspace_websocket_broadcast", broadcast, { payload, seq: envelope.seq, event: envelope.event })
  }
  const deliver = (envelope: UiEventEnvelope): void => measureStage("workspace_event_delivery", deliverNow, envelope)

  const scheduleCaptureRetry = (backlog = false): void => {
    if (stopped || captureRetryTimer) return
    const delayMs = backlog ? 0 : Math.min(1_000, 50 * 2 ** Math.min(captureRetryAttempt, 4))
    if (!backlog) captureRetryAttempt += 1
    captureRetryTimer = setTimeout(() => {
      captureRetryTimer = undefined
      captureTranscript()
      if (!scheduled) flush()
    }, delayMs)
    captureRetryTimer.unref()
  }

  // Also recovers a committed tail whose publisher stopped before delivery.
  const captureTranscript = (): void => {
    if (!database || stopped) return
    const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    database.exec("PRAGMA busy_timeout = 0")
    try {
      const more = measureStage("transcript_journal_capture", captureEntries, database)
      captureRetryAttempt = 0
      if (more) scheduleCaptureRetry(true)
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
      void runRetentionMaintenance(true)
    }, 100)
    retentionTimer.unref()
  }

  const runRetentionMaintenance = async (force = false): Promise<void> => {
    if (!retention || stopped || retentionRunning || (!force && delivered - compactedAt < 256)) return

    retentionRunning = true
    const through = delivered
    try {
      const more = await measureStage("transcript_retention", () => retention.run(), undefined)
      compactedAt = through
      if (more || delivered - compactedAt >= 256) scheduleRetention()
    } catch {
      scheduleRetention()
    } finally {
      retentionRunning = false
    }
  }

  const getPublicationKey = (event: UiEvent | MessageRef): string | undefined => {
    if (isMessageRef(event)) return JSON.stringify([event.threadId, event.messageId, event.seq])
    if (event.type === "message.created" || event.type === "message.updated") {
      if (event.message.updatedSeq === undefined) return undefined
      return JSON.stringify([event.message.threadId, event.message.id, event.message.updatedSeq])
    }
    if (event.type === "message.delta" || event.type === "message.parts") {
      if (event.updatedSeq === undefined) return undefined
      return JSON.stringify([event.threadId, event.messageId, event.updatedSeq])
    }
    return undefined
  }

  const rememberPublication = (event: UiEvent): void => {
    const key = getPublicationKey(event)
    if (!key) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > REPLAY_LIMITS.bytes) return
    if (database?.inTransaction) {
      const snapshot = structuredClone(event)
      onDatabaseCommit(database, () => {
        rememberPublication(snapshot)
        if (!scheduled) flush()
      })
      return
    }
    const previous = publications.filter((publication) => publication.key !== key)
    const fits =
      previous.length < LIVE_DELIVERY_LIMITS.events &&
      previous.reduce((total, publication) => total + publication.bytes, bytes) <= REPLAY_LIMITS.bytes
    // Keep a bounded committed revision cache for live delivery and immediate reconnects.
    const next = { key, event: structuredClone(event), bytes, through: head() }
    publications = fits ? previous.concat(next) : [next]
    if (liveRead?.key !== key) return
    const previousRead = liveRead
    liveRead = undefined
    previousRead.abort.abort()
    flushing = false
  }

  const getPublishedReference = (reference: MessageRef, seq: number): UiEvent | undefined => {
    const event = publications.find(
      (publication) => publication.key === getPublicationKey(reference) && publication.through >= seq,
    )?.event
    if (event?.type === "message.created" || event?.type === "message.updated")
      return { type: reference.type as "message.created" | "message.updated", message: event.message }
    return event
  }

  const getHydratedRef = (event: MessageRef): UiEvent =>
    measureStage(
      "workspace_snapshot",
      (reference) => (database ? getRefEvent(database, reference) : { type: "transcript.superseded" }),
      event,
    )

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

  /** Synchronous inspection helper; transport delivery uses the asynchronous reference reader. */
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
  const getCatchUp = (since: number, signal: AbortSignal): Array<UiEventEnvelope> | Promise<Array<UiEventEnvelope>> => {
    const through = head()
    const resync = (): Array<UiEventEnvelope> => [
      { seq: through, at: Date.now(), event: { type: "transcript.resync" } },
    ]
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
    const getCoalesced = (references: Map<MessageRef, UiEvent>): Array<UiEventEnvelope> => {
      const sent = new Set<string>()
      const coalesced: Array<UiEventEnvelope> = []
      let bytes = 0
      for (const [index, row] of rows.entries()) {
        const value = stored[index] as UiEvent | MessageRef
        const key = keyOf(value)
        let event: UiEvent
        if (!key)
          event = isMessageRef(value)
            ? (references.get(value) ?? { type: "transcript.superseded" })
            : (value as UiEvent)
        else if (sent.has(key)) event = { type: "transcript.superseded" }
        else {
          sent.add(key)
          const newest = stored[latest.get(key) ?? index] as UiEvent | MessageRef
          const revision = isMessageRef(newest) ? (references.get(newest) ?? { type: "transcript.superseded" }) : newest
          event =
            revision.type === "message.created" || revision.type === "message.updated"
              ? { type: value.type as "message.created" | "message.updated", message: revision.message }
              : { type: "transcript.superseded" }
        }
        if (event.type === "transcript.resync") return resync()
        const envelope = { seq: row.seq, at: row.at, event }
        bytes += Buffer.byteLength(payloadFor(envelope))
        if (bytes > REPLAY_LIMITS.bytes) return resync()
        coalesced.push(envelope)
      }
      return coalesced
    }
    const references = stored.filter((event, index): event is MessageRef => {
      if (!isMessageRef(event)) return false
      const key = keyOf(event)
      return !key || latest.get(key) === index
    })
    const cached = new Map(
      rows.flatMap((row, index) => {
        const reference = stored[index]
        if (!isMessageRef(reference)) return []
        const event = getPublishedReference(reference, row.seq)
        return event ? [[reference, event] as const] : []
      }),
    )
    const missing = references.filter((reference) => !cached.has(reference))
    if (!missing.length || !getReferences) return getCoalesced(cached)

    return getReferences(missing, signal, REPLAY_LIMITS.bytes).then((events) => {
      if (events.some((event) => event.type === "transcript.resync")) return resync()
      return getCoalesced(
        new Map([
          ...cached,
          ...missing.map(
            (reference, index) => [reference, events[index] ?? { type: "transcript.superseded" }] as const,
          ),
        ]),
      )
    })
  }
  const scheduleFlush = (initial = false): void => {
    if (scheduled || stopped) return

    scheduled = true
    cancelContinuation = initial ? scheduleCommittedDelivery(flush) : schedule(flush)
  }

  const finishFlush = (retry = false): void => {
    flushing = false
    if (stopped) return
    if (retry) {
      readRetryTimer = setTimeout(() => {
        readRetryTimer = undefined
        scheduleFlush()
      }, 100)
      readRetryTimer.unref()
      return
    }
    if (delivered < head()) scheduleFlush()
    else void runRetentionMaintenance()
  }

  const flushReferences = async (rows: Row[]): Promise<void> => {
    const stored = rows.map((row) => JSON.parse(row.event_json) as UiEvent | MessageRef)
    const references = stored.filter(isMessageRef)
    const read = { key: stored[0] ? getPublicationKey(stored[0]) : undefined, abort: new AbortController() }
    liveRead = read
    let ownsDelivery = false
    try {
      const events = await getReferences?.(references, read.abort.signal, REPLAY_LIMITS.bytes)
      if (stopped || liveRead !== read) return
      ownsDelivery = true
      liveRead = undefined
      const hydrated = new Map(references.map((reference, index) => [reference, events?.[index]]))
      const startedAt = now()
      for (const [index, row] of rows.entries()) {
        if (stopped) break
        const value = stored[index]
        if (!value) break
        const event = isMessageRef(value) ? hydrated.get(value) : value
        if (!event) {
          // A bounded reply ends at its resync marker; continue its durable suffix on another turn.
          if (events?.at(-1)?.type === "transcript.resync") break
          throw new Error("EVENT_READ_FAILED")
        }
        delivered = row.seq
        deliver({ seq: row.seq, at: row.at, event })
        if (now() - startedAt >= LIVE_DELIVERY_LIMITS.budgetMs) break
      }
      finishFlush()
    } catch {
      if (!ownsDelivery && liveRead !== read) return
      liveRead = undefined
      // Retry the durable cursor; a failed reader must not skip a committed event.
      finishFlush(true)
    }
  }

  const flush = (): void => {
    scheduled = false
    cancelContinuation = undefined
    if (!database || stopped || flushing || readRetryTimer) return

    flushing = true
    const startedAt = now()
    let deferred = false
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
        for (const [index, row] of pending.entries()) {
          if (stopped) break

          const value = JSON.parse(row.event_json) as UiEvent | MessageRef
          const event = isMessageRef(value) ? getPublishedReference(value, row.seq) : value
          if (!event) {
            if (deliveredCount > 0) {
              scheduleFlush(true)
              return
            }
            deferred = true
            void flushReferences(pending.slice(index))
            return
          }
          const envelope = { seq: row.seq, at: row.at, event }
          delivered = envelope.seq
          deliveredCount += 1
          deliver(envelope)
          if (now() - startedAt >= LIVE_DELIVERY_LIMITS.budgetMs) break
        }
        if (now() - startedAt >= LIVE_DELIVERY_LIMITS.budgetMs) break
      }
    } finally {
      if (!deferred) finishFlush()
    }
    if (stopped || delivered < head() || delivered - compactedAt < 256) return

    void runRetentionMaintenance()
  }
  const flushAsync = async (): Promise<void> => {
    const through = head()
    if (!database || delivered >= through) return
    const deadline = performance.now() + 5_000
    if (!scheduled) flush()
    while (!stopped && delivered < through) {
      if (performance.now() >= deadline) throw new Error("EVENT_DELIVERY_TIMEOUT")
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    if (stopped && delivered < through) throw new Error("EVENT_DELIVERY_STOPPED")
  }

  const writeEvent = (event: UiEvent): void => {
    if (!database) return
    const at = Date.now()
    const payload = JSON.stringify(event.type === "process.log" ? boundedProcessLog(event) : event)
    const inserted = database.query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)").run(at, payload)
    if (!isControlEvent(event)) return
    const envelope = { seq: Number(inserted.lastInsertRowid), at, event: JSON.parse(payload) as UiEvent }
    const notify = (): void => {
      // Internal run/approval coordination cannot wait behind a cold transcript read.
      if (envelope.seq <= delivered || earlyControls.has(envelope.seq) || stopped) return
      // At the replay bound, normal durable delivery owns the remaining callbacks.
      if (earlyControls.size >= REPLAY_LIMITS.events) return
      earlyControls.add(envelope.seq)
      measureStage("workspace_event_delivery", () => notifyListeners(envelope, true), undefined)
    }
    if (database.inTransaction) onDatabaseCommit(database, notify)
    else notify()
  }
  const publish = (event: UiEvent): void => {
    if (stopped) return
    if (!database) {
      deliver({ seq: ++sequence, at: Date.now(), event })
      return
    }
    captureTranscript()
    rememberPublication(event)
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

  const sendReplay = (entry: SocketEntry, envelopes: UiEventEnvelope[]): void => {
    const { socket, filter, replay } = entry
    if (!replay) return
    const { abort } = replay
    if (stopped || abort.signal.aborted) return
    const sinceHead = replay.overflow ? head() : entry.since
    const payloads = replay.overflow
      ? [payloadFor({ seq: sinceHead, at: Date.now(), event: { type: "transcript.resync" } })]
      : envelopes
          .map((envelope) => {
            const visible =
              filter && envelope.event.type !== "transcript.resync" && !filter(envelope.event)
                ? { seq: envelope.seq, at: 0, event: { type: "transcript.superseded" as const } }
                : envelope
            return payloadFor(visible)
          })
          .concat(
            replay.payloads.map(({ payload, seq, event }) =>
              filter && !filter(event) ? payloadFor({ seq, at: 0, event: { type: "transcript.superseded" } }) : payload,
            ),
          )
    for (const payload of payloads) {
      if (stopped || abort.signal.aborted) return
      if (socket.readyState !== 1 || socket.sendText(payload) === 0) {
        removeSocket(socket)
        socket.close?.(1013, "Tente reconectar")
        return
      }
    }
    sockets = sockets.map((current) => (current === entry ? { socket, since: sinceHead, filter } : current))
  }

  return {
    publish,
    flushAsync,
    subscribeRuntime: (listener: (envelope: UiEventEnvelope) => void): (() => void) => {
      runtimeListeners.add(listener)
      return () => runtimeListeners.delete(listener)
    },
    subscribe: (listener: (envelope: UiEventEnvelope) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    add: (socket: EventSocket, since = 0, filter?: EventFilter): void => {
      if (stopped) return
      captureTranscript()
      if (!scheduled) flush()
      if (!database) {
        sockets = sockets.concat({ socket, since: sequence, filter })
        return
      }
      void runRetentionMaintenance(true)
      const abort = new AbortController()
      const replay: SocketReplay = { abort, payloads: [], bytes: 0, overflow: false }
      const entry: SocketEntry = { socket, since: head(), filter, replay }
      sockets = sockets.concat(entry)
      try {
        const result = getCatchUp(since, abort.signal)
        if (result instanceof Promise) {
          void result
            .then((envelopes) => sendReplay(entry, envelopes))
            .catch(() => {
              removeSocket(socket)
              socket.close?.(1013, "Tente reconectar")
            })
          return
        }
        sendReplay(entry, result)
      } catch {
        removeSocket(socket)
        socket.close?.(1013, "Tente reconectar")
      }
    },
    remove: (socket: EventSocket): void => {
      removeSocket(socket)
    },
    replay,
    catchUp: (since: number): Promise<UiEventEnvelope[]> => Promise.resolve(getCatchUp(since, shutdown.signal)),
    stop: async (): Promise<void> => {
      stopped = true
      shutdown.abort()
      liveRead?.abort.abort()
      liveRead = undefined
      sockets.forEach((entry) => {
        entry.replay?.abort.abort()
      })
      reader?.dispose()
      clearTimeout(readRetryTimer)
      cancelContinuation?.()
      clearTimeout(retentionTimer)
      clearTimeout(captureRetryTimer)
      sockets = []
      publications = []
      earlyControls.clear()
      await retention?.dispose()
    },
  }
}

type SocketReplay = {
  abort: AbortController
  payloads: Array<{ payload: string; seq: number; event: UiEvent }>
  bytes: number
  overflow: boolean
}
type SocketEntry = { socket: EventSocket; since: number; filter?: EventFilter | undefined; replay?: SocketReplay }

type DeliveryScheduling = {
  now?: () => number
  schedule?: (action: () => void) => () => void
  getReferenceEvents?: (references: TranscriptRef[], signal: AbortSignal, maxBytes?: number) => Promise<UiEvent[]>
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
