import type { Database } from "bun:sqlite"
import type { Kernel, Message, MessagePart, StoreApi, Thread, UiEvent } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"
import { captureTranscript } from "../kernel/transcript-events"
import { materializeTranscript } from "../kernel/transcript-storage"
import { createStreamPartWriter } from "./stream-parts"
import { appendRejection, recordTranscriptRejection } from "./transcript-rejections"

export const STREAM_WRITE_LIMITS = {
  delayMs: 100,
  bytes: 8 * 1024,
  checkpointMs: 5_000,
  batchBytes: 64 * 1024,
  batchEvents: 64,
}
const BUSY_WARNING_INTERVAL_MS = 60_000
type Delta = Extract<UiEvent, { type: "message.delta" }>
type Parts = Extract<UiEvent, { type: "message.parts" }>
type StreamEvent = Delta | Parts
type Projection = {
  message: Message
  writeParts: ReturnType<typeof createStreamPartWriter>
  baseSeq: number
  lastEvent: string | null
  textDeltas: Map<number, Array<string>>
  textLengths: Map<number, number>
}
const getEventBytes = (event: StreamEvent): number =>
  event.type === "message.delta" ? Buffer.byteLength(event.delta) : Buffer.byteLength(JSON.stringify(event.parts))

const isBusyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  error.code.startsWith("SQLITE_BUSY")

const isSnapshotCovered = (projection: Projection, seq: number | undefined): boolean =>
  seq !== undefined && seq >= projection.baseSeq && seq <= (projection.message.updatedSeq ?? 0)

const resolutionOf = (part: Extract<MessagePart, { callId: string }>) => {
  if (part.resolution) return part.resolution
  if (part.type === "tool_call" && part.ok !== null) return part.ok ? "succeeded" : "failed"
  if (part.type === "command" && part.exitCode !== null) return part.exitCode === 0 ? "succeeded" : "failed"
  return part.type === "file_change" ? "succeeded" : "running"
}

// Never split a UTF-8 character, including when a single provider frame exceeds the budget.
const chunks = (text: string): string[] => {
  if (Buffer.byteLength(text) <= STREAM_WRITE_LIMITS.bytes) return [text]
  const result: string[] = []
  let chunk = ""
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > STREAM_WRITE_LIMITS.bytes) {
      result.push(chunk)
      chunk = ""
      bytes = 0
    }
    chunk += char
    bytes += size
  }
  if (chunk) result.push(chunk)
  return result
}

export const createStreamWriter = ({
  kernel,
  database,
  getMessage,
  getThread,
  runStage,
  getNow = Date.now,
}: {
  kernel: Kernel
  database: Database
  getMessage: (input: { threadId: string; messageId: string }) => Message | null
  getThread: (input: { threadId: string }) => Thread | null
  runStage?: PerformanceStageRunner
  getNow?: () => number
}) => {
  let pending: StreamEvent[] = []
  let pendingBytes = 0
  const projections = new Map<string, Projection>()
  const runBytes = new Map<string, number>()
  const lastByMessage = new Map<string, StreamEvent>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let checkpointAt = getNow()
  let checkpointCursor = 0
  let flushing = false
  let stopped = false
  let lastBusyWarningAt = Number.NEGATIVE_INFINITY
  let batchesWritten = 0
  const outside = new WeakSet<StreamEvent>()
  let unsettled: Array<{ event: StreamEvent; raw: string | null; seq: number }> = []
  const warnBufferedWrites = (msg: string): void => {
    try {
      kernel.log({ level: "warn", module: "store", msg, data: { events: pending.length, bytes: pendingBytes } })
    } catch {
      // Storage failure can also prevent writing diagnostics; retain the accepted batch.
    }
  }
  const warnBusyRetry = (): void => {
    const now = Date.now()
    if (now - lastBusyWarningAt < BUSY_WARNING_INTERVAL_MS) return

    lastBusyWarningAt = now
    warnBufferedWrites("Stream database busy; retrying buffered writes")
  }
  const keyOf = (threadId: string, messageId: string): string => JSON.stringify([threadId, messageId])
  const createProjection = (message: Message, baseSeq: number, lastEvent: string | null = null): Projection => ({
    message,
    writeParts: createStreamPartWriter(database, kernel.paths.appData, message.parts),
    baseSeq,
    lastEvent,
    textDeltas: new Map(),
    textLengths: new Map(
      message.parts.flatMap((part, index) => ("text" in part ? [[index, part.text.length] as const] : [])),
    ),
  })
  const materializeProjectionText = (projection: Projection): void => {
    if (!projection.textDeltas.size) return
    const materialize = (): void => {
      for (const [partIndex, deltas] of projection.textDeltas) {
        const part = projection.message.parts[partIndex]
        if (!part || (part.type !== "text" && part.type !== "reasoning")) continue
        const text = part.text + deltas.join("")
        projection.message.parts[partIndex] = { ...part, text }
        projection.textLengths.set(partIndex, text.length)
      }
      projection.textDeltas.clear()
      projection.message.text = projection.message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    }
    if (runStage) runStage("stream_text_materialization", materialize)
    else materialize()
  }
  const getSnapshotSeq = (threadId: string, messageId: string): number | undefined =>
    (
      database.query("SELECT updated_seq FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId) as {
        updated_seq: number
      } | null
    )?.updated_seq

  const tailSeq = (threadId: string, messageId: string): number =>
    (
      database
        .query(`SELECT MAX(seq) AS seq FROM (
      SELECT seq FROM (SELECT seq FROM transcript_entries INDEXED BY transcript_delta_message
        WHERE thread_id = ? AND json_extract(event_json, '$.messageId') = ?
          AND json_extract(event_json, '$.type') = 'message.delta'
        ORDER BY seq DESC LIMIT 1)
      UNION ALL
      SELECT seq FROM (SELECT e.seq FROM transcript_part_entries p JOIN transcript_entries e ON e.id = p.entry_id
        WHERE p.thread_id = ? AND p.message_id = ? ORDER BY p.entry_id DESC LIMIT 1)
    )`)
        .get(threadId, messageId, threadId, messageId) as { seq: number | null }
    ).seq ?? 0

  const rebuildQueueState = (): void => {
    runBytes.clear()
    lastByMessage.clear()
    pendingBytes = 0
    for (const event of pending) {
      const key = keyOf(event.threadId, event.messageId)
      const bytes = getEventBytes(event)
      pendingBytes += bytes
      runBytes.set(key, (runBytes.get(key) ?? 0) + bytes)
      lastByMessage.set(key, event)
    }
  }

  const settle = (): void => {
    if (!unsettled.length || database.inTransaction) return
    const lost = unsettled.filter(({ event, raw, seq }) => {
      if (raw === null) {
        // A temporarily stale generation/status may itself have rolled back.
        const thread = getThread({ threadId: event.threadId })
        const message = getMessage({ threadId: event.threadId, messageId: event.messageId })
        return thread?.generation === event.generation && message?.status === "streaming"
      }
      const row = database
        .query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
        .get(event.threadId, seq) as { event_json: string } | null
      return row?.event_json !== raw
    })
    unsettled = []
    if (!lost.length) return
    // Only work accepted before the outer transaction belongs to the retry.
    // Work created by that transaction must disappear with its rollback.
    projections.clear()
    for (const { event } of lost) {
      const restored = structuredClone(event)
      delete restored.updatedSeq
      outside.add(restored)
      pending.push(restored)
    }
    rebuildQueueState()
  }

  const flush = (): void => {
    if (stopped || flushing) return
    settle()
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending.length) {
      if (unsettled.length) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
      return
    }
    flushing = true
    let batchBytes = 0
    let batchCount = 0
    for (const event of pending) {
      if (batchCount >= STREAM_WRITE_LIMITS.batchEvents) break
      const bytes = getEventBytes(event)
      if (batchCount > 0 && batchBytes + bytes > STREAM_WRITE_LIMITS.batchBytes) break
      batchBytes += bytes
      batchCount++
      if (batchBytes >= STREAM_WRITE_LIMITS.batchBytes) break
    }
    const batch = pending.slice(0, batchCount)
    pending = pending.slice(batchCount)
    rebuildQueueState()
    const committed: StreamEvent[] = []
    const outerTransaction = database.inTransaction
    const awaitingCommit: typeof unsettled = []
    const previousBusyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    try {
      const writeBatch = database.transaction(() => {
        const rebased = new Map<string, Message>()
        const checked = new Set<string>()
        for (const event of batch) {
          const key = keyOf(event.threadId, event.messageId)
          if (checked.has(key)) continue
          checked.add(key)
          const cached = projections.get(key)
          const headSeq = getSnapshotSeq(event.threadId, event.messageId)
          if (
            !cached ||
            !isSnapshotCovered(cached, headSeq) ||
            tailSeq(event.threadId, event.messageId) > (cached.message.updatedSeq ?? 0)
          ) {
            materializeTranscript(database)
            const message = getMessage({ threadId: event.threadId, messageId: event.messageId })
            if (message) rebased.set(key, message)
          }
        }
        for (const event of batch) {
          const outcome =
            outerTransaction && outside.has(event)
              ? { event: structuredClone(event), raw: null as string | null, seq: 0 }
              : null
          if (outcome) awaitingCommit.push(outcome)
          const thread = getThread({ threadId: event.threadId })
          const head = database
            .query("SELECT status, run_id FROM messages WHERE thread_id = ? AND id = ?")
            .get(event.threadId, event.messageId) as { status: string; run_id: string | null } | null
          const run = head?.run_id
            ? (database.query("SELECT status, thread_id FROM runs WHERE id = ?").get(head.run_id) as {
                status: string
                thread_id: string
              } | null)
            : null
          if (
            !thread ||
            thread.generation !== event.generation ||
            head?.status !== "streaming" ||
            (run && !["queued", "starting", "running"].includes(run.status))
          ) {
            if (event.type === "message.delta") recordTranscriptRejection(kernel, event, "stale_generation")
            projections.delete(keyOf(event.threadId, event.messageId))
            continue
          }
          const seq = (thread.updatedSeq ?? 0) + 1
          if (
            database.query("SELECT 1 FROM transcript_entries WHERE thread_id = ? AND seq = ?").get(event.threadId, seq)
          ) {
            if (event.type === "message.delta") recordTranscriptRejection(kernel, event, "seq_conflict")
            projections.delete(keyOf(event.threadId, event.messageId))
            materializeTranscript(database)
            const message = getMessage({ threadId: event.threadId, messageId: event.messageId })
            if (message) rebased.set(keyOf(event.threadId, event.messageId), message)
            continue
          }
          const rebasedMessage = rebased.get(keyOf(event.threadId, event.messageId))
          if (rebasedMessage) {
            if (event.type === "message.delta") {
              const part = rebasedMessage.parts[event.partIndex]
              if (
                event.partIndex > rebasedMessage.parts.length ||
                (part && part.type !== "text" && part.type !== "reasoning")
              ) {
                recordTranscriptRejection(kernel, event, "validation")
                continue
              }
              const text = part && "text" in part ? part.text : ""
              event.offset = text.length
              rebasedMessage.parts[event.partIndex] = {
                ...part,
                type: event.partType ?? "text",
                text: text + event.delta,
              }
            } else {
              for (const { partIndex, part } of event.parts) rebasedMessage.parts[partIndex] = structuredClone(part)
            }
            rebasedMessage.text = rebasedMessage.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("")
          }
          event.updatedSeq = seq
          database.query("UPDATE threads SET updated_seq = ? WHERE id = ?").run(seq, event.threadId)
          const raw = JSON.stringify(event)
          const entry = database
            .query("INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES (?, ?, ?, ?, ?)")
            .run(event.threadId, seq, event.generation ?? 1, raw, event.updatedAt ?? Date.now())
          if (outcome) {
            outcome.raw = raw
            outcome.seq = seq
          }
          if (event.type === "message.parts")
            database
              .query("INSERT INTO transcript_part_entries(entry_id, thread_id, message_id) VALUES (?, ?, ?)")
              .run(entry.lastInsertRowid, event.threadId, event.messageId)
          if (event.type === "message.parts" && head.run_id && run?.thread_id === event.threadId) {
            for (const { part } of event.parts) {
              if (!("callId" in part)) continue
              database
                .query(`INSERT INTO tool_resolutions(run_id, call_id, thread_id, part_json, resolution, resolved_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET
                part_json = excluded.part_json, resolution = excluded.resolution, resolved_at = excluded.resolved_at
                WHERE tool_resolutions.part_json IS NOT excluded.part_json
                  OR tool_resolutions.resolution IS NOT excluded.resolution
                  OR tool_resolutions.resolved_at IS NOT excluded.resolved_at`)
                .run(
                  head.run_id,
                  part.callId,
                  event.threadId,
                  JSON.stringify(part),
                  resolutionOf(part),
                  part.resolvedAt ?? null,
                )
            }
          }
          const key = keyOf(event.threadId, event.messageId)
          if (rebasedMessage)
            projections.set(key, createProjection(rebasedMessage, getSnapshotSeq(event.threadId, event.messageId) ?? 0))
          const projection = projections.get(key)
          if (projection) {
            projection.message.updatedSeq = seq
            projection.lastEvent = raw
          }
          committed.push(event)
        }
        if (runStage) runStage("transcript_journal_capture", captureTranscript, database)
        else captureTranscript(database)
        if (getNow() - checkpointAt >= STREAM_WRITE_LIMITS.checkpointMs) {
          // One projection per interval bounds work across concurrent replies; the journal is already durable.
          const current = Array.from(projections.values())
          const projection = current[checkpointCursor % current.length]
          if (projection) {
            const target = { threadId: projection.message.threadId, messageId: projection.message.id }
            const checkpoint = () => materializeTranscript(database, target)
            if (runStage) runStage("transcript_projection_checkpoint", checkpoint)
            else checkpoint()
            materializeProjectionText(projection)
            projection.baseSeq = projection.message.updatedSeq ?? projection.baseSeq
            projection.lastEvent = null
          }
          checkpointCursor += 1
          checkpointAt = getNow()
        }
      })
      database.exec("PRAGMA busy_timeout = 0")
      try {
        if (runStage) runStage("stream_journal_write", writeBatch)
        else writeBatch()
      } finally {
        database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout}`)
      }
      unsettled.push(...awaitingCommit)
      batchesWritten++
      // Publication sees only committed journal entries (or waits for an outer transaction).
      for (const event of committed) kernel.publish(event)
    } catch (error) {
      // A failed transaction can leave an in-memory rebase only partly applied.
      // Retry the complete batch against durable state, including all offsets.
      for (const event of batch) projections.delete(keyOf(event.threadId, event.messageId))
      pending = [...batch, ...pending]
      rebuildQueueState()
      if (isBusyError(error)) {
        warnBusyRetry()
        return
      }
      throw error
    } finally {
      flushing = false
      if ((pending.length || unsettled.length) && !timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
    }
  }

  let retrying = false
  const flushLater = (): void => {
    try {
      if (runStage) runStage("stream_batch", flush)
      else flush()
      retrying = false
    } catch {
      // Keep the queue for retry; a background callback must not kill the server.
      try {
        if (!retrying)
          kernel.log({ level: "error", module: "store", msg: "Stream persistence failed; retrying buffered writes" })
      } catch {
        // The same full disk can also prevent writing the diagnostic log.
      }
      retrying = true
    }
  }

  const projectionFor = (threadId: string, messageId: string): Projection | null => {
    const key = keyOf(threadId, messageId)
    const cached = projections.get(key)
    if (cached) {
      // Validate once per byte-bounded batch; flush rechecks durable state and rebases all offsets atomically.
      if (runBytes.has(key) && !database.inTransaction) return cached
      const head = database
        .query("SELECT updated_seq, generation, status FROM messages WHERE thread_id = ? AND id = ?")
        .get(threadId, messageId) as { updated_seq: number; generation: number; status: string } | null
      const last = cached.lastEvent
        ? (database
            .query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
            .get(threadId, cached.message.updatedSeq ?? 0) as { event_json: string } | null)
        : null
      if (
        head &&
        isSnapshotCovered(cached, head.updated_seq) &&
        head.generation === cached.message.generation &&
        head.status === "streaming" &&
        (!cached.lastEvent || last?.event_json === cached.lastEvent) &&
        tailSeq(threadId, messageId) <= (cached.message.updatedSeq ?? 0)
      )
        return cached
      flush()
      // Another writer or recovery may have advanced the projection.
      materializeTranscript(database)
    }
    // An outer transaction may have rolled back a snapshot after draining the
    // writer. Recover its already committed tail before choosing new offsets.
    let message = getMessage({ threadId, messageId })
    if (!message) return null
    if (
      !cached &&
      database
        .query(`
      SELECT 1 FROM transcript_entries INDEXED BY transcript_delta_message
        WHERE thread_id = ? AND json_extract(event_json, '$.messageId') = ? AND seq > ?
          AND json_extract(event_json, '$.type') = 'message.delta'
      UNION ALL
      SELECT 1 FROM transcript_part_entries p JOIN transcript_entries e ON e.id = p.entry_id
        WHERE p.thread_id = ? AND p.message_id = ? AND e.seq > ? LIMIT 1
    `)
        .get(threadId, messageId, message.updatedSeq ?? 0, threadId, messageId, message.updatedSeq ?? 0)
    ) {
      materializeTranscript(database)
      message = getMessage({ threadId, messageId })
      if (!message) return null
    }
    const next = createProjection(message, message.updatedSeq ?? 0)
    projections.set(key, next)
    return next
  }

  const beforeAppend = (): void => {
    settle()
    // Keep preaccepted work distinct from work owned by an outer transaction.
    if (pending.length && (database.inTransaction || !projections.size)) flush()
  }

  const queue = (event: StreamEvent, bytes: number): void => {
    if (!database.inTransaction) outside.add(event)
    const eventKey = keyOf(event.threadId, event.messageId)
    const last = lastByMessage.get(eventKey)
    if (
      event.type === "message.delta" &&
      last?.type === "message.delta" &&
      last.threadId === event.threadId &&
      last.messageId === event.messageId &&
      last.partIndex === event.partIndex &&
      outside.has(last) === outside.has(event) &&
      last.generation === event.generation &&
      (last.offset ?? 0) + last.delta.length === event.offset &&
      Buffer.byteLength(last.delta) + bytes <= STREAM_WRITE_LIMITS.bytes
    ) {
      last.delta += event.delta
      last.updatedAt = event.updatedAt ?? Date.now()
    } else {
      pending.push(event)
      lastByMessage.set(eventKey, event)
    }
    const key = keyOf(event.threadId, event.messageId)
    const size = (runBytes.get(key) ?? 0) + bytes
    runBytes.set(key, size)
    pendingBytes += bytes
    if (
      size >= STREAM_WRITE_LIMITS.bytes ||
      pending.length >= STREAM_WRITE_LIMITS.batchEvents ||
      pendingBytes >= STREAM_WRITE_LIMITS.batchBytes ||
      database.inTransaction
    )
      flush()
    else if (!timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
  }

  const appendDelta: StoreApi["appendDelta"] = (input) => {
    beforeAppend()
    // Explicit optimistic-concurrency writes retain their immediate sequence semantics.
    if (input.expectedSeq !== undefined) flush()
    const thread = getThread({ threadId: input.threadId })
    const reject = (reason: Parameters<typeof recordTranscriptRejection>[2]): void => {
      flush()
      recordTranscriptRejection(kernel, input, reason)
    }
    const invalid = appendRejection(input, thread)
    if (invalid) return reject(invalid)
    const current = projectionFor(input.threadId, input.messageId)
    if (!current || !thread) return reject("validation")
    const message = current.message
    if (message.generation !== thread.generation || message.status !== "streaming") return reject("stale_generation")
    const run = message.runId
      ? (database.query("SELECT status FROM runs WHERE id = ?").get(message.runId) as { status: string } | null)
      : null
    if (run && !["queued", "starting", "running"].includes(run.status)) return reject("stale_generation")
    const part = message.parts[input.partIndex]
    if (input.partIndex > message.parts.length || (part && part.type !== "text" && part.type !== "reasoning"))
      return reject("validation")
    for (const delta of chunks(input.delta)) {
      const buffered = runBytes.get(keyOf(input.threadId, input.messageId)) ?? 0
      if (buffered && buffered + Buffer.byteLength(delta) > STREAM_WRITE_LIMITS.bytes) flush()
      const projection = projectionFor(input.threadId, input.messageId)
      if (!projection) return reject("validation")
      const previous = projection.message.parts[input.partIndex]
      const type = previous?.type === "reasoning" ? "reasoning" : "text"
      const baseLength = previous && "text" in previous ? previous.text.length : 0
      const offset = projection.textLengths.get(input.partIndex) ?? baseLength
      const deltas = projection.textDeltas.get(input.partIndex) ?? []
      // Keep provider chunks in a local append-only buffer; the growing message is joined only at checkpoints.
      deltas.push(delta)
      projection.textDeltas.set(input.partIndex, deltas)
      projection.textLengths.set(input.partIndex, offset + delta.length)
      if (!previous) projection.message.parts[input.partIndex] = { type, text: "" }
      queue(
        {
          type: "message.delta",
          threadId: input.threadId,
          messageId: input.messageId,
          partIndex: input.partIndex,
          delta,
          offset,
          partType: type,
          generation: thread.generation ?? 1,
          updatedAt: Date.now(),
        },
        Buffer.byteLength(delta),
      )
    }
    if (input.expectedSeq !== undefined) flush()
  }

  const appendParts: NonNullable<StoreApi["appendParts"]> = (input) => {
    beforeAppend()
    let thread = getThread({ threadId: input.threadId })
    let current = projectionFor(input.threadId, input.messageId)
    if (
      !current ||
      !thread ||
      (input.generation !== undefined && input.generation !== thread.generation) ||
      current.message.generation !== thread.generation ||
      current.message.status !== "streaming"
    )
      return
    const validateIndices = (initialLength: number): void => {
      let length = initialLength
      for (const patch of input.parts) {
        if (!Number.isSafeInteger(patch.partIndex) || patch.partIndex < 0 || patch.partIndex > length)
          throw new Error("Invalid stream part index")
        if (patch.partIndex === length) length++
      }
    }
    // A later invalid patch must not change offsets in the cached projection or
    // externalize an earlier part. Prepare the whole event before applying it.
    validateIndices(current.message.parts.length)
    const prepared = input.parts.map(({ partIndex, part }) => ({ partIndex, part: structuredClone(part) }))
    const changesText = prepared.some(
      ({ partIndex, part }) =>
        part.type === "text" ||
        part.type === "reasoning" ||
        current?.message.parts[partIndex]?.type === "text" ||
        current?.message.parts[partIndex]?.type === "reasoning",
    )
    if (changesText) materializeProjectionText(current)

    const preparedProjection = current
    let parts = runStage
      ? runStage("stream_part_preparation", current.writeParts, prepared)
      : current.writeParts(prepared)
    if (!parts.length) return

    const patchBytes = Buffer.byteLength(JSON.stringify(parts))
    const buffered = runBytes.get(keyOf(input.threadId, input.messageId)) ?? 0
    // Small patches share the delta batch cap. An indivisible live progress
    // payload above 8 KiB flushes immediately and may include bounded deltas;
    // retaining its complete live tail is required for existing UI behavior.
    if (patchBytes <= STREAM_WRITE_LIMITS.bytes && buffered && buffered + patchBytes > STREAM_WRITE_LIMITS.bytes) {
      flush()
      thread = getThread({ threadId: input.threadId })
      current = projectionFor(input.threadId, input.messageId)
      if (
        !current ||
        !thread ||
        (input.generation !== undefined && input.generation !== thread.generation) ||
        current.message.generation !== thread.generation ||
        current.message.status !== "streaming"
      )
        return
      validateIndices(current.message.parts.length)
      if (current !== preparedProjection) parts = current.writeParts(prepared)
    }
    const bytes = current === preparedProjection ? patchBytes : Buffer.byteLength(JSON.stringify(parts))
    for (const [index, patch] of parts.entries()) {
      current.message.parts[patch.partIndex] = structuredClone(patch.part)
      current.textDeltas.delete(patch.partIndex)
      if ("text" in patch.part) current.textLengths.set(patch.partIndex, patch.part.text.length)
      else current.textLengths.delete(patch.partIndex)
      const original = input.parts[index]
      if (original) original.part = structuredClone(patch.part)
    }
    if (changesText && !current.textDeltas.size)
      current.message.text = current.message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    queue(
      {
        type: "message.parts",
        threadId: input.threadId,
        messageId: input.messageId,
        parts,
        generation: thread.generation ?? 1,
        updatedAt: Date.now(),
      },
      bytes,
    )
    // A completed result is a durability boundary, even for a short output.
    if (parts.some(({ part }) => "callId" in part && resolutionOf(part) !== "running")) flush()
  }

  const drain = ({ stopping = false }: { stopping?: boolean } = {}): void => {
    if (stopped || flushing) return
    settle()
    // Subscribers can enqueue group mirrors during publication. Lifecycle/read
    // boundaries must include that work before closing or taking a snapshot.
    while (pending.length) {
      const previousBatches = batchesWritten
      flush()
      if (batchesWritten === previousBatches) break
    }
    if (!stopping) return

    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    if (pending.length) warnBufferedWrites("Shutdown could not persist buffered stream writes; database remains busy")
  }

  return {
    appendDelta,
    appendParts,
    flush,
    drain,
    invalidate: (threadId: string, messageId: string): void => {
      projections.delete(keyOf(threadId, messageId))
    },
    checkpoint: (): void => {
      drain()
      // A busy writer keeps its accepted batch for the timer retry; reads use the last committed snapshot.
      if (pending.length) return
      const materialize = (): void => materializeTranscript(database)
      if (runStage) runStage("transcript_projection_checkpoint", materialize)
      else materialize()
      projections.clear()
      checkpointAt = getNow()
    },
  }
}
