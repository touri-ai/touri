import type { Database } from "bun:sqlite"
import type { Kernel, Message, MessagePart, StoreApi, Thread, UiEvent } from "@touri/contracts"
import { externalizeMessageParts } from "../kernel/output-blobs"
import { captureTranscript } from "../kernel/transcript-events"
import { materializeTranscript } from "../kernel/transcript-storage"
import { appendRejection, recordTranscriptRejection } from "./transcript-rejections"

export const STREAM_WRITE_LIMITS = { delayMs: 100, bytes: 8 * 1024, checkpointMs: 5_000 }
type Delta = Extract<UiEvent, { type: "message.delta" }>
type Parts = Extract<UiEvent, { type: "message.parts" }>
type StreamEvent = Delta | Parts
type Projection = { message: Message; baseSeq: number; lastEvent: string | null }
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
}: {
  kernel: Kernel
  database: Database
  getMessage: (input: { threadId: string; messageId: string }) => Message | null
  getThread: (input: { threadId: string }) => Thread | null
}) => {
  let pending: StreamEvent[] = []
  const projections = new Map<string, Projection>()
  const runBytes = new Map<string, number>()
  const lastByMessage = new Map<string, StreamEvent>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let checkpointAt = Date.now()
  let flushing = false
  const outside = new WeakSet<StreamEvent>()
  let unsettled: Array<{ event: StreamEvent; raw: string | null; seq: number }> = []
  const keyOf = (threadId: string, messageId: string): string => JSON.stringify([threadId, messageId])

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
    runBytes.clear()
    lastByMessage.clear()
  }

  const flush = (): void => {
    if (flushing) return
    settle()
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending.length) {
      if (unsettled.length) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
      return
    }
    flushing = true
    const batch = pending
    const committed: StreamEvent[] = []
    const outerTransaction = database.inTransaction
    const awaitingCommit: typeof unsettled = []
    try {
      database.transaction(() => {
        const rebased = new Map<string, Message>()
        for (const event of batch) {
          const key = keyOf(event.threadId, event.messageId)
          if (rebased.has(key)) continue
          const cached = projections.get(key)
          const head = getMessage({ threadId: event.threadId, messageId: event.messageId })
          if (
            !cached ||
            head?.updatedSeq !== cached.baseSeq ||
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
                part_json = excluded.part_json, resolution = excluded.resolution, resolved_at = excluded.resolved_at`)
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
            projections.set(key, {
              message: rebasedMessage,
              baseSeq: getMessage({ threadId: event.threadId, messageId: event.messageId })?.updatedSeq ?? 0,
              lastEvent: null,
            })
          const projection = projections.get(key)
          if (projection) {
            projection.message.updatedSeq = seq
            projection.lastEvent = raw
          }
          committed.push(event)
        }
        captureTranscript(database)
        if (Date.now() - checkpointAt >= STREAM_WRITE_LIMITS.checkpointMs) {
          materializeTranscript(database)
          for (const projection of projections.values()) {
            projection.baseSeq = projection.message.updatedSeq ?? projection.baseSeq
            projection.lastEvent = null
          }
          checkpointAt = Date.now()
        }
      })()
      unsettled.push(...awaitingCommit)
      pending = []
      runBytes.clear()
      lastByMessage.clear()
      // Publication sees only committed journal entries (or waits for an outer transaction).
      for (const event of committed) kernel.publish(event)
    } catch (error) {
      // A failed transaction can leave an in-memory rebase only partly applied.
      // Retry the complete batch against durable state, including all offsets.
      for (const event of batch) projections.delete(keyOf(event.threadId, event.messageId))
      throw error
    } finally {
      flushing = false
      if ((pending.length || unsettled.length) && !timer) timer = setTimeout(flushLater, STREAM_WRITE_LIMITS.delayMs)
    }
  }

  let retrying = false
  const flushLater = (): void => {
    try {
      flush()
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
      const head = database
        .query("SELECT updated_seq, generation, status FROM messages WHERE thread_id = ? AND id = ?")
        .get(threadId, messageId) as { updated_seq: number; generation: number; status: string } | null
      const last = cached.lastEvent
        ? (database
            .query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
            .get(threadId, cached.message.updatedSeq ?? 0) as { event_json: string } | null)
        : null
      if (
        head?.updated_seq === cached.baseSeq &&
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
    const next = { message, baseSeq: message.updatedSeq ?? 0, lastEvent: null }
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
    if (size >= STREAM_WRITE_LIMITS.bytes || database.inTransaction) flush()
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
      const target = projectionFor(input.threadId, input.messageId)?.message
      if (!target) return reject("validation")
      const previous = target.parts[input.partIndex]
      const type = previous?.type === "reasoning" ? "reasoning" : "text"
      const offset = previous?.type === "text" || previous?.type === "reasoning" ? previous.text.length : 0
      target.parts[input.partIndex] = {
        ...previous,
        type,
        text: (previous && "text" in previous ? previous.text : "") + delta,
      } as MessagePart
      if (type === "text") target.text += delta
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
    const parts = prepared.map(({ partIndex, part }) => ({
      partIndex,
      part: externalizeMessageParts({ database, appData: kernel.paths.appData, parts: [part] })[0] ?? part,
    }))
    if (!parts.length) return
    const bytes = Buffer.byteLength(JSON.stringify(parts))
    const buffered = runBytes.get(keyOf(input.threadId, input.messageId)) ?? 0
    // Small patches share the delta batch cap. An indivisible live progress
    // payload above 8 KiB flushes immediately and may include bounded deltas;
    // retaining its complete live tail is required for existing UI behavior.
    if (bytes <= STREAM_WRITE_LIMITS.bytes && buffered && buffered + bytes > STREAM_WRITE_LIMITS.bytes) {
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
    }
    for (const [index, patch] of parts.entries()) {
      current.message.parts[patch.partIndex] = structuredClone(patch.part)
      const original = input.parts[index]
      if (original) original.part = structuredClone(patch.part)
    }
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

  const drain = (): void => {
    if (flushing) return
    settle()
    // Subscribers can enqueue group mirrors during publication. Lifecycle/read
    // boundaries must include that work before closing or taking a snapshot.
    while (pending.length) flush()
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
      materializeTranscript(database)
      projections.clear()
      checkpointAt = Date.now()
    },
  }
}
