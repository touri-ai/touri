import type { Database } from "bun:sqlite"
import type { Kernel, Message, MessagePart, StoreApi, Thread, UiEvent } from "@touri/contracts"
import type { OutputBlobAttachment, OutputBlobWrite } from "../kernel/output-blobs"
import type { PerformanceStageRunner } from "../kernel/performance"
import { createStreamPartWriter, type PreparedStreamParts } from "./stream-parts"
import { createStreamPersistence, type RejectionWrite } from "./stream-persistence"
import { appendRejection } from "./transcript-rejections"

export const STREAM_WRITE_LIMITS = {
  delayMs: 100,
  bytes: 8 * 1024,
  batchBytes: 64 * 1024,
  batchEvents: 64,
  pendingBytes: 8 * 1024 * 1024,
  pendingEvents: 4_096,
}
type Delta = Extract<UiEvent, { type: "message.delta" }>
type Parts = Extract<UiEvent, { type: "message.parts" }>
type PendingDelta = Delta & { expectedSeq?: number; snapshotSeq?: number }
type PendingParts = Parts & {
  snapshotSeq?: number
  _outputBlobFiles?: OutputBlobWrite[]
  _outputBlobAttachments?: OutputBlobAttachment[]
}
type PendingStreamEvent = PendingDelta | PendingParts
type PendingEvent = PendingStreamEvent | RejectionWrite
type Projection = {
  message: Message
  writeParts: ReturnType<typeof createStreamPartWriter>
  baseSeq: number
  lastEvent: string | null
  textDeltas: Map<number, Array<string>>
  textLengths: Map<number, number>
}
const getEventBytes = (event: PendingEvent): number => Buffer.byteLength(JSON.stringify(event))
const getPayloadBytes = (event: PendingEvent): number => {
  if (event.type === "message.delta") return Buffer.byteLength(event.delta)
  if (event.type === "message.parts")
    return (
      Buffer.byteLength(JSON.stringify(event.parts)) +
      (event._outputBlobFiles ?? []).reduce((total, file) => total + file.bytes, 0)
    )
  return getEventBytes(event)
}
const getCleanEvent = (event: PendingEvent): PendingEvent => {
  if (event.type !== "message.parts") return event
  const { _outputBlobFiles: _files, _outputBlobAttachments: _attachments, ...clean } = event

  return clean
}

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
  createWorker,
}: {
  kernel: Kernel
  database: Database
  getMessage: (input: { threadId: string; messageId: string }) => Message | null
  getThread: (input: { threadId: string }) => Thread | null
  runStage?: PerformanceStageRunner
  getNow?: () => number
  createWorker?: (url: string) => Worker
}) => {
  // Stream buffers mutate locally so provider chunks stay append-only and bounded.
  let pending: PendingEvent[] = []
  let pendingBytes = 0
  let inFlight: PendingEvent[] = []
  let inFlightBytes = 0
  const projections = new Map<string, Projection>()
  const runBytes = new Map<string, number>()
  const inFlightMessages = new Set<string>()
  const lastByMessage = new Map<string, PendingStreamEvent>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  const failed = new WeakSet<PendingEvent>()
  let capacityReported = false
  let stopped = false
  const outside = new WeakSet<PendingEvent>()
  const persistence = createStreamPersistence({
    database,
    appData: kernel.paths.appData,
    ...(createWorker ? { createWorker } : {}),
    publish: (event) => kernel.publish(event),
    onReadyWaitExceeded: () => {
      try {
        kernel.log({
          level: "warn",
          module: "store",
          msg: "Stream persistence startup is taking longer than expected; store readiness is continuing while writes remain buffered",
        })
      } catch {
        // A storage failure can also prevent writing the diagnostic.
      }
    },
    onError: () => {
      try {
        kernel.log({
          level: "error",
          module: "store",
          msg: "Stream persistence unavailable; buffered writes may be rejected",
        })
      } catch {
        // A full disk can also prevent writing the diagnostic log.
      }
    },
  })
  const ensureCapacity = (bytes: number, events = 1): void => {
    const bufferedEvents = pending.length + inFlight.length + events
    const bufferedBytes = pendingBytes + inFlightBytes + bytes
    if (stopped) throw new Error("Stream writer is closed")
    if (bufferedBytes <= STREAM_WRITE_LIMITS.pendingBytes && bufferedEvents <= STREAM_WRITE_LIMITS.pendingEvents) return
    if (!capacityReported) {
      capacityReported = true
      try {
        kernel.log({ level: "error", module: "store", msg: "Stream buffer limit reached; rejecting additional writes" })
      } catch {
        // Storage pressure can also prevent writing its diagnostic.
      }
    }
    throw new Error("Stream buffer limit exceeded")
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
      pendingBytes += getEventBytes(event)
      if (event.type === "stream.rejection") continue
      const key = keyOf(event.threadId, event.messageId)
      const bytes = getPayloadBytes(event)
      runBytes.set(key, (runBytes.get(key) ?? 0) + bytes)
      lastByMessage.set(key, event)
    }
  }

  const flush = (): void => {
    if (stopped || flushing) return
    if (database.inTransaction) {
      if (!timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
      return
    }
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending.length) {
      return
    }
    flushing = true
    let batchBytes = 0
    let batchCount = 0
    for (const event of pending) {
      if (batchCount >= STREAM_WRITE_LIMITS.batchEvents) break
      const bytes = getPayloadBytes(event)
      if (batchCount > 0 && batchBytes + bytes > STREAM_WRITE_LIMITS.batchBytes) break
      batchBytes += bytes
      batchCount++
      if (batchBytes >= STREAM_WRITE_LIMITS.batchBytes) break
    }
    const batch = pending.slice(0, batchCount)
    pending = pending.slice(batchCount)
    rebuildQueueState()
    const eligible = batch.filter((event) => outside.has(event))
    if (!eligible.length) {
      flushing = false
      if (pending.length && !timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
      return
    }
    if (eligible.length !== batch.length) {
      for (const event of batch) projections.delete(keyOf(event.threadId, event.messageId))
    }
    const startedAt = performance.now()
    inFlight = eligible
    for (const event of eligible) inFlightMessages.add(keyOf(event.threadId, event.messageId))
    inFlightBytes = eligible.reduce((total, event) => total + getEventBytes(event), 0)
    const files = eligible.flatMap((event) => (event.type === "message.parts" ? (event._outputBlobFiles ?? []) : []))
    const attachments = eligible.flatMap((event) =>
      event.type === "message.parts" ? (event._outputBlobAttachments ?? []) : [],
    )
    void persistence
      .submit(eligible.map(getCleanEvent), { files, attachments })
      .then(({ events, rejected, quarantined }) => {
        if (quarantined)
          eligible.forEach((event) => {
            failed.add(event)
          })
        inFlight = []
        inFlightBytes = 0
        const durationMs = performance.now() - startedAt
        if (durationMs > STREAM_WRITE_LIMITS.delayMs) {
          try {
            kernel.log({
              level: "debug",
              module: "store",
              msg: "Stream persistence batch committed",
              data: { events: events.length, durationMs: Math.round(durationMs) },
            })
          } catch {
            // Storage timing must not affect publication or retries.
          }
        }
        for (const event of events) {
          const projection = projections.get(keyOf(event.threadId, event.messageId))
          if (!projection) continue
          if (event.updatedSeq !== undefined) projection.message.updatedSeq = event.updatedSeq
          projection.lastEvent = JSON.stringify(event)
        }
        for (const event of rejected) projections.delete(keyOf(event.rejection.threadId, event.rejection.messageId))
      })
      .catch(() => {
        inFlight = []
        inFlightBytes = 0
        for (const event of eligible) projections.delete(keyOf(event.threadId, event.messageId))
        eligible.forEach((event) => {
          failed.add(event)
        })
        try {
          kernel.publish({ type: "transcript.resync" })
        } catch {
          // A failed subscriber cannot restart a quarantined batch.
        }
      })
      .finally(() => {
        inFlightMessages.clear()
        flushing = false
        if (!pending.length) capacityReported = false
        if (!stopped && pending.length && !timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
      })
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
      if ((runBytes.has(key) || inFlightMessages.has(key)) && !database.inTransaction) return cached
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
      projections.delete(key)
    }
    const message = getMessage({ threadId, messageId })
    if (!message) return null
    const next = createProjection(message, message.updatedSeq ?? 0)
    projections.set(key, next)
    return next
  }

  const beforeAppend = (): void => {
    // A surrounding SQLite transaction cannot be shared with the worker.
    if (pending.length && (database.inTransaction || !projections.size)) flush()
  }

  const queue = (event: PendingStreamEvent, bytes: number): void => {
    if (!database.inTransaction) outside.add(event)
    const eventKey = keyOf(event.threadId, event.messageId)
    const last = lastByMessage.get(eventKey)
    const previousBytes = last ? getEventBytes(last) : 0
    let addedBytes = getEventBytes(event)
    if (
      event.type === "message.delta" &&
      last?.type === "message.delta" &&
      last.threadId === event.threadId &&
      last.messageId === event.messageId &&
      last.partIndex === event.partIndex &&
      last.expectedSeq === event.expectedSeq &&
      outside.has(last) === outside.has(event) &&
      last.generation === event.generation &&
      (last.offset ?? 0) + last.delta.length === event.offset &&
      Buffer.byteLength(last.delta) + bytes <= STREAM_WRITE_LIMITS.bytes
    ) {
      last.delta += event.delta
      last.updatedAt = event.updatedAt ?? Date.now()
      addedBytes = getEventBytes(last) - previousBytes
    } else {
      pending.push(event)
      lastByMessage.set(eventKey, event)
    }
    const key = keyOf(event.threadId, event.messageId)
    const size = (runBytes.get(key) ?? 0) + bytes
    runBytes.set(key, size)
    pendingBytes += addedBytes
    if (
      size >= STREAM_WRITE_LIMITS.bytes ||
      pending.length >= STREAM_WRITE_LIMITS.batchEvents ||
      pendingBytes >= STREAM_WRITE_LIMITS.batchBytes ||
      database.inTransaction
    )
      flush()
    else if (!timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
  }

  const queueRejection = (event: RejectionWrite): void => {
    ensureCapacity(getEventBytes(event))
    if (!database.inTransaction) outside.add(event)
    pending.push(event)
    pendingBytes += getEventBytes(event)
    flush()
  }

  const appendDelta: StoreApi["appendDelta"] = (input) => {
    beforeAppend()
    // Explicit optimistic-concurrency writes retain their immediate sequence semantics.
    if (input.expectedSeq !== undefined) flush()
    const thread = getThread({ threadId: input.threadId })
    const reject = (reason: RejectionWrite["reason"]): void => {
      queueRejection({
        type: "stream.rejection",
        threadId: input.threadId,
        messageId: input.messageId,
        partIndex: input.partIndex,
        ...(input.generation === undefined ? {} : { generation: input.generation }),
        ...(input.expectedSeq === undefined ? {} : { expectedSeq: input.expectedSeq }),
        reason,
      })
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
    const deltas = chunks(input.delta)
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...input, delta: "" })) + 256
    ensureCapacity(Buffer.byteLength(JSON.stringify(input.delta)) + deltas.length * envelopeBytes, deltas.length)
    for (const [index, delta] of deltas.entries()) {
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
          updatedAt: getNow(),
          snapshotSeq: projection.baseSeq,
          ...(index === 0 && input.expectedSeq !== undefined ? { expectedSeq: input.expectedSeq } : {}),
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
          throw new Error(`Invalid stream part index ${patch.partIndex} at length ${length}`)
        if (patch.partIndex === length) length++
      }
    }
    // A later invalid patch must not change offsets in the cached projection or
    // externalize an earlier part. Prepare the whole event before applying it.
    validateIndices(current.message.parts.length)
    ensureCapacity(Buffer.byteLength(JSON.stringify(input)) + 256)
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
    let result: PreparedStreamParts = runStage
      ? runStage("stream_part_preparation", current.writeParts, prepared)
      : current.writeParts(prepared)
    let parts = result.parts
    if (!parts.length) return

    const fileBytes = Array.from(new Map(result.files.map((file) => [file.id, file])).values()).reduce(
      (total, file) => total + file.bytes,
      0,
    )
    const patchBytes = Buffer.byteLength(JSON.stringify(parts)) + fileBytes
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
      if (current !== preparedProjection) {
        result = current.writeParts(prepared)
        parts = result.parts
      }
    }
    const currentFiles = Array.from(new Map(result.files.map((file) => [file.id, file])).values())
    const currentAttachments = Array.from(
      new Map(result.attachments.map((attachment) => [attachment.id, attachment])).values(),
    )
    const bytes = Buffer.byteLength(JSON.stringify(parts)) + currentFiles.reduce((total, file) => total + file.bytes, 0)
    ensureCapacity(
      Buffer.byteLength(JSON.stringify({ threadId: input.threadId, messageId: input.messageId, parts })) +
        currentFiles.reduce((total, file) => total + file.bytes, 0) +
        256,
    )
    parts.forEach((patch, index) => {
      current.message.parts[patch.partIndex] = structuredClone(patch.part)
      current.textDeltas.delete(patch.partIndex)
      if ("text" in patch.part) current.textLengths.set(patch.partIndex, patch.part.text.length)
      else current.textLengths.delete(patch.partIndex)
      const original = input.parts[index]
      if (original) original.part = structuredClone(patch.part)
    })
    if (changesText && !current.textDeltas.size)
      current.message.text = current.message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    queue(
      {
        type: "message.parts",
        threadId: input.threadId,
        messageId: input.messageId,
        parts,
        snapshotSeq: current.baseSeq,
        generation: thread.generation ?? 1,
        updatedAt: getNow(),
        ...(currentFiles.length ? { _outputBlobFiles: currentFiles } : {}),
        ...(currentAttachments.length ? { _outputBlobAttachments: currentAttachments } : {}),
      },
      bytes,
    )
    // A completed result is a durability boundary, even for a short output.
    if (parts.some(({ part }) => "callId" in part && resolutionOf(part) !== "running")) flush()
  }

  const drain = ({ stopping = false }: { stopping?: boolean } = {}): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = null
    flush()
    if (!stopping) return

    stopped = true
    void persistence.close()
  }

  const drainAsync = async ({
    stopping = false,
    threadId,
    messageId,
  }: {
    stopping?: boolean
    threadId?: string
    messageId?: string
  } = {}): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    const deadline = stopping ? Date.now() + 2_000 : Number.POSITIVE_INFINITY
    const inScope = (event: PendingEvent): boolean =>
      (threadId === undefined || event.threadId === threadId) &&
      (messageId === undefined || event.messageId === messageId)
    const watermark = new Set(pending.concat(inFlight).filter(inScope))
    const hasWatermark = (): boolean =>
      pending.some((event) => watermark.has(event)) || inFlight.some((event) => watermark.has(event))
    while (hasWatermark() && Date.now() < deadline) {
      if (!flushing) flush()
      const remainingMs = Math.min(20, deadline - Date.now())
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, remainingMs)))
    }
    if (!stopping) {
      if (Array.from(watermark).some((event) => failed.has(event))) throw new Error("Stream writes were rejected")
      return
    }

    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    if (pending.length || flushing) {
      try {
        kernel.log({
          level: "warn",
          module: "store",
          msg: "Shutdown could not persist buffered stream writes; database remains busy",
          data: {
            events: pending.length + inFlight.length,
            bytes: pending.concat(inFlight).reduce((total, event) => total + getPayloadBytes(event), 0),
          },
        })
      } catch {
        // A full disk can also prevent writing the diagnostic log.
      }
    }
    await persistence.close()
  }

  return {
    appendDelta,
    appendParts,
    flush,
    drain,
    drainAsync,
    closeIfIdle: (): boolean => {
      if (pending.length || flushing) return false
      if (!persistence.closeIfIdle()) return false
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      return true
    },
    ready: persistence.ready,
    getProjectedMessage: (threadId: string, messageId: string): Message | null => {
      const projection = projections.get(keyOf(threadId, messageId))
      if (!projection) return null
      materializeProjectionText(projection)
      return structuredClone(projection.message)
    },
    invalidate: (threadId: string, messageId: string): void => {
      projections.delete(keyOf(threadId, messageId))
      pending = pending.filter((event) => event.threadId !== threadId || event.messageId !== messageId)
      rebuildQueueState()
    },
    checkpoint: (): void => flush(),
  }
}
