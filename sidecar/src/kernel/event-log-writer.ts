import type { Database } from "bun:sqlite"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"

const MAX_PENDING_EVENTS = 2_000
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const WRITE_DEADLINE_MS = 5_000

type PendingEvent = { at: number; payload: string; bytes: number; deadline: number }

/** Contended event inserts yield; delivery still starts only after durable persistence. */
export const createEventLogWriter = (database: Database, onSaved: (envelope: UiEventEnvelope) => void) => {
  // This connection owns the bounded backlog and retry timer, including shutdown draining.
  let pending: PendingEvent[] = []
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let completion: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let failure: Error | undefined

  const insert = (event: PendingEvent): UiEventEnvelope => {
    const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    database.exec("PRAGMA busy_timeout = 0")
    try {
      const inserted = database
        .query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)")
        .run(event.at, event.payload)
      return { seq: Number(inserted.lastInsertRowid), at: event.at, event: JSON.parse(event.payload) as UiEvent }
    } finally {
      database.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
    }
  }

  const schedule = (): void => {
    if (timer || failure) return
    timer = setTimeout(drain, 10)
  }

  const drain = (): void => {
    timer = undefined
    const startedAt = performance.now()
    // Bound both the inserts and callbacks before giving timers and requests another turn.
    for (let count = 0; count < 32; count += 1) {
      const next = pending[0]
      if (!next) break
      let envelope: UiEventEnvelope
      try {
        if (database.inTransaction) throw getEventWriteBusyError()
        envelope = insert(next)
      } catch (error) {
        if (isEventWriteBusy(error) && performance.now() < next.deadline) {
          schedule()
          return
        }
        failure = new Error("EVENT_PERSISTENCE_FAILED")
        completion?.reject(failure)
        return
      }
      pending = pending.slice(1)
      pendingBytes -= next.bytes
      onSaved(envelope)
      if (performance.now() - startedAt >= 8) break
    }
    if (pending.length > 0) {
      schedule()
      return
    }
    completion?.resolve()
    completion = undefined
  }

  const save = (event: UiEvent): void => {
    if (failure) throw failure
    // A retried owned transaction must not overtake already admitted events. Its caller
    // retries after rollback, so no uncommitted event ever escapes into the backlog.
    if (pending.length > 0 && database.inTransaction) throw getEventWriteBusyError()
    const payload = JSON.stringify(event)
    const next = { at: Date.now(), payload, bytes: payload.length * 2, deadline: performance.now() + WRITE_DEADLINE_MS }
    if (pending.length === 0) {
      let envelope: UiEventEnvelope | undefined
      try {
        envelope = insert(next)
      } catch (error) {
        if (database.inTransaction || !isEventWriteBusy(error)) throw error
      }
      if (envelope) {
        onSaved(envelope)
        return
      }
    }
    if (pending.length >= MAX_PENDING_EVENTS || pendingBytes + next.bytes > MAX_PENDING_BYTES)
      throw new Error("EVENT_PERSISTENCE_CAPACITY")
    if (!completion) {
      completion = Promise.withResolvers<void>()
      // A timer can discover a storage failure before the caller requests a flush.
      void completion.promise.catch(() => undefined)
    }
    pending = pending.concat(next)
    pendingBytes += next.bytes
    schedule()
  }

  return {
    save,
    flushAsync: async (): Promise<void> => {
      if (failure) throw failure
      await completion?.promise
    },
  }
}

const isEventWriteBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))

const getEventWriteBusyError = (): Error =>
  Object.assign(new Error("Event persistence is busy"), { code: "SQLITE_BUSY" })
