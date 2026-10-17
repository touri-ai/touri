import type { Database } from "bun:sqlite"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"
import type { ServerWebSocket } from "bun"
import { captureTranscript as captureEntries, type TranscriptRef } from "./transcript-events"
import { compactTranscript, materializeTranscript } from "./transcript-storage"

export type EventSocketData = { channel: "events"; since?: number }

/** A reconnect replays at most this much; a larger gap is cheaper to reload over REST. */
export const REPLAY_LIMITS = { events: 2_000, bytes: 2 * 1024 * 1024 }

type MessageRef = TranscriptRef
const isMessageRef = (value: unknown): value is MessageRef =>
  typeof value === "object" && value !== null && (value as { ref?: unknown }).ref === true
const messageKey = (event: UiEvent): string | null =>
  event.type === "message.created" || event.type === "message.updated"
    ? JSON.stringify([event.message.threadId, event.message.id])
    : null

type EventSocket = Pick<ServerWebSocket<unknown>, "readyState" | "sendText"> &
  Partial<Pick<ServerWebSocket<unknown>, "close">>

export const createEventBus = (database?: Database) => {
  let sequence = 0
  const listeners = new Set<(envelope: UiEventEnvelope) => void>()
  const sockets = new Set<EventSocket>()
  let delivered = Number(
    (database?.query("SELECT seq FROM sqlite_sequence WHERE name = 'ui_event_log'").get() as { seq: number } | null)
      ?.seq ?? 0,
  )
  let scheduled = false
  let stopped = false
  let flushing = false
  let compactedAt = delivered
  const payloadFor = (envelope: UiEventEnvelope): string =>
    JSON.stringify(envelope.event.type === "transcript.resync" ? { type: "resync", lastSeq: envelope.seq } : envelope)

  const deliver = (envelope: UiEventEnvelope): void => {
    const payload = payloadFor(envelope)
    for (const listener of listeners) {
      try {
        listener(envelope)
      } catch {
        // A subscriber must not turn a committed write into a failed request.
      }
    }
    for (const socket of sockets) {
      try {
        if (socket.readyState !== 1 || socket.sendText(payload) === 0) {
          sockets.delete(socket)
          socket.close?.(1013, "Tente reconectar")
        }
      } catch {
        // A window reload can close its socket between iteration and send.
        // That client must not interrupt persistence or other subscribers.
        sockets.delete(socket)
      }
    }
  }

  // Also recovers a committed tail whose publisher stopped before delivery.
  const captureTranscript = (): void => {
    if (database && !stopped) captureEntries(database)
  }

  const hydrateRef = (event: MessageRef): UiEvent => {
    if (!database) return { type: "transcript.superseded" }
    const entry = database
      .query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
      .get(event.threadId, event.seq) as { event_json: string } | null
    const revision = entry ? (JSON.parse(entry.event_json) as UiEvent) : null
    if (
      (revision?.type === "message.created" || revision?.type === "message.updated") &&
      revision.message.id === event.messageId
    )
      return revision
    if (event.type === "message.delta" || event.type === "message.parts") {
      if (
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
  const hydrate = (raw: string): UiEvent => {
    const event = JSON.parse(raw) as UiEvent | MessageRef
    return isMessageRef(event) ? hydrateRef(event) : event
  }

  const head = (): number =>
    (database?.query("SELECT seq FROM sqlite_sequence WHERE name = 'ui_event_log'").get() as { seq: number } | null)
      ?.seq ?? 0

  type Row = { seq: number; at: number; event_json: string }
  /** The stored rows after `since`, or null when that cursor is outside the retained log. */
  const rowsAfter = (since: number): Array<Row> | null => {
    if (!database) return []
    const floor = Number(
      (database.query("SELECT value FROM schema_meta WHERE key = 'ui_event_floor_seq'").get() as { value: string })
        .value,
    )
    if (since < floor || since > head()) return null
    return database
      .query("SELECT seq, at, event_json FROM ui_event_log WHERE seq > ? ORDER BY seq")
      .all(since) as Array<Row>
  }

  const replay = (since: number): Array<UiEventEnvelope> => {
    const rows = rowsAfter(since)
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
    const pending = (database.query("SELECT COUNT(*) AS n FROM ui_event_log WHERE seq > ?").get(since) as { n: number })
      .n
    if (pending > REPLAY_LIMITS.events) return resync()
    const rows = rowsAfter(since)
    if (!rows) return resync()
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
      if (!key) event = isMessageRef(value) ? hydrateRef(value) : (value as UiEvent)
      else if (sent.has(key)) event = { type: "transcript.superseded" }
      else {
        sent.add(key)
        const newest = stored[latest.get(key) ?? index] as UiEvent | MessageRef
        const revision = isMessageRef(newest) ? hydrateRef(newest) : newest
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
  const flush = (): void => {
    scheduled = false
    if (!database || stopped || flushing) return
    flushing = true
    try {
      while (!stopped) {
        const pending = replay(delivered)
        if (!pending.length) break
        for (const envelope of pending) {
          delivered = envelope.seq
          deliver(envelope)
        }
      }
    } finally {
      flushing = false
    }
    if (delivered - compactedAt >= 256) {
      compactTranscript({ database })
      compactedAt = delivered
    }
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
      database.query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)").run(Date.now(), JSON.stringify(event))
    if (database.inTransaction) {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(flush)
      }
    } else flush()
  }
  captureTranscript()
  if (database) {
    materializeTranscript(database)
  }

  return {
    publish,
    subscribe: (listener: (envelope: UiEventEnvelope) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    add: (socket: EventSocket, since = 0): void => {
      captureTranscript()
      flush()
      if (database) {
        compactTranscript({ database })
        for (const envelope of catchUp(since)) {
          if (socket.sendText(payloadFor(envelope)) === 0) {
            socket.close?.(1013, "Tente reconectar")
            return
          }
        }
      }
      sockets.add(socket)
    },
    remove: (socket: EventSocket): void => {
      sockets.delete(socket)
    },
    replay,
    catchUp,
    stop: (): void => {
      stopped = true
    },
  }
}
