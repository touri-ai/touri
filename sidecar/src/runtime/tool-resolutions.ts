import { Database } from "bun:sqlite"
import { isDeepStrictEqual } from "node:util"
import type { Kernel, Message, MessagePart, Run, StoreApi, ToolResolution } from "@touri/contracts"
import { writeDatabaseAsync } from "../kernel/database-write"
import { externalizeMessagePartsAsync } from "../kernel/output-blobs"
import type { PerformanceStageRunner } from "../kernel/performance"
import { summarizeToolResolutions } from "./tool-resolution-summary"

type ToolPart = Extract<MessagePart, { callId: string }>
type StoredResolution = { resolution: ToolResolution; resolved_at: number | null; part_json: string }
type ResolutionBatch = {
  stored: Map<string, StoredResolution>
  writes: Map<string, StoredResolution>
  cleared: Set<string>
}
type FinishReason = Exclude<ToolResolution, "running">
export type PreparedToolFinish = (parts: MessagePart[], reason: FinishReason) => MessagePart[]
type RecoveryRun = { id: string; thread_id: string; status: Run["status"]; reply_message_id: string | null }

export const PENDING_TOOL_RECOVERY_SQL = `SELECT r.id, r.thread_id, r.status, r.reply_message_id
  FROM tool_recovery_pending p CROSS JOIN runs r
  WHERE r.id = p.run_id AND r.status IN ('succeeded','failed','canceled','interrupted')`
const isTool = (part: MessagePart): part is ToolPart => "callId" in part
const outcome = (part: ToolPart): ToolResolution => {
  if (part.resolution === "completed_unobserved") return "completed_unobserved"
  if (part.type === "tool_call" && part.ok !== null) return part.ok ? "succeeded" : "failed"
  if (part.type === "command" && part.exitCode !== null) return part.exitCode === 0 ? "succeeded" : "failed"
  if (part.type === "file_change") return part.resolution ?? "succeeded"
  return part.resolution ?? "running"
}
const hasResult = (resolution: ToolResolution) =>
  resolution === "succeeded" || resolution === "failed" || resolution === "completed_unobserved"
const interrupted = (resolution: ToolResolution) =>
  ["canceled", "interrupted", "cancelled_by_user", "interrupted_by_restart"].includes(resolution)
const terminalReason = (status: Run["status"]): Exclude<ToolResolution, "running"> =>
  status === "canceled"
    ? "cancelled_by_user"
    : status === "interrupted"
      ? "interrupted_by_restart"
      : status === "failed"
        ? "failed"
        : "unknown"

export const createToolResolutions = (kernel: Kernel) => {
  const database = kernel.db instanceof Database ? kernel.db : null
  // Cancellation must fence late tool results before the worker has committed its disposition.
  const pendingInterruptions = new Map<string, Map<string, ToolPart>>()
  const getResolution = database?.query(
    "SELECT resolution, resolved_at, part_json FROM tool_resolutions WHERE run_id = ? AND call_id = ?",
  )
  const saveResolution =
    database?.query(`INSERT INTO tool_resolutions(run_id, call_id, thread_id, part_json, resolution, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET
      part_json = excluded.part_json, resolution = excluded.resolution, resolved_at = excluded.resolved_at
      WHERE tool_resolutions.part_json IS NOT excluded.part_json
        OR tool_resolutions.resolution IS NOT excluded.resolution
        OR tool_resolutions.resolved_at IS NOT excluded.resolved_at`)
  const getRunParts = database?.query(
    "SELECT call_id, part_json, resolution, resolved_at FROM tool_resolutions WHERE run_id = ? ORDER BY rowid",
  )
  const getPendingToolCall = database?.query("SELECT 1 FROM tool_calls WHERE run_id = ? AND ok IS NULL LIMIT 1")
  const record = (run: Run, part: ToolPart, recovering = false, persist = true, batch?: ResolutionBatch): ToolPart => {
    const stored = batch
      ? (batch.stored.get(part.callId) ?? null)
      : (getResolution?.get(run.id, part.callId) as StoredResolution | null)
    const pending = batch?.cleared.has(part.callId) ? undefined : pendingInterruptions.get(run.id)?.get(part.callId)
    const previous = pending
      ? { resolution: outcome(pending), resolved_at: pending.resolvedAt ?? null, part_json: JSON.stringify(pending) }
      : stored
    let resolution = outcome(part)
    const keepResult = previous && hasResult(previous.resolution) && !hasResult(resolution)
    const unobserved =
      previous && ((hasResult(resolution) && interrupted(previous.resolution)) || (recovering && keepResult))
    if (resolution === "running" && previous && previous.resolution !== "running") resolution = previous.resolution
    if (keepResult) resolution = previous.resolution
    if (unobserved || (previous?.resolution === "completed_unobserved" && hasResult(resolution)))
      resolution = "completed_unobserved"
    const resultPart = keepResult && previous ? (JSON.parse(previous.part_json) as ToolPart) : part
    const completedOutcome =
      resultPart.type === "file_change"
        ? (resultPart.completedOutcome ??
          (outcome(resultPart) === "failed" ? "failed" : outcome(resultPart) === "succeeded" ? "succeeded" : undefined))
        : undefined
    const resolvedAt =
      resolution === "running"
        ? null
        : (part.resolvedAt ?? (previous?.resolution === resolution ? previous.resolved_at : null) ?? Date.now())
    const hasCompletedOutcome =
      resolution === "completed_unobserved" && resultPart.type === "file_change" && completedOutcome !== undefined
    const resolved = {
      ...part,
      ...(keepResult && !("outputAttachmentId" in part) ? resultPart : {}),
      resolution,
      ...(hasCompletedOutcome ? { completedOutcome } : {}),
      resolvedAt,
    }
    const next = resolved
    if (persist) {
      const partJson = JSON.stringify(next)
      const row = { part_json: partJson, resolution, resolved_at: next.resolvedAt ?? null }
      if (batch) {
        if (!hasSameStoredResolution(stored, row, next)) batch.writes.set(part.callId, row)
        batch.stored.set(part.callId, row)
        batch.cleared.add(part.callId)
      } else {
        saveResolution?.run(run.id, part.callId, run.threadId, partJson, resolution, next.resolvedAt ?? null)
        clearPendingPart(run.id, part.callId)
      }
    }
    if (!persist && (pending || interrupted(resolution))) {
      const parts = pendingInterruptions.get(run.id) ?? new Map<string, ToolPart>()
      parts.set(part.callId, next)
      pendingInterruptions.set(run.id, parts)
    }
    return next
  }
  const recordAsync = async (
    run: Run,
    part: ToolPart,
    recovering = false,
    persist = true,
    runStage?: PerformanceStageRunner,
  ): Promise<ToolPart> => {
    const measure = <Value>(action: () => Value): Value =>
      runStage ? runStage("runtime_part_finalization", action) : action()
    const resolved = measure(() => record(run, part, recovering, false))
    const next = database
      ? ((
          await measure(() =>
            externalizeMessagePartsAsync({ database, appData: kernel.paths.appData, parts: [resolved] }),
          )
        )[0] as ToolPart)
      : resolved

    return measure(() => saveAsyncResult(run, part.callId, next, persist))
  }
  const saveAsyncResult = (run: Run, callId: string, next: ToolPart, persist: boolean): ToolPart => {
    const resolution = outcome(next)
    if (persist) {
      saveResolution?.run(run.id, callId, run.threadId, JSON.stringify(next), resolution, next.resolvedAt ?? null)
      const parts = pendingInterruptions.get(run.id)
      parts?.delete(callId)
      if (!parts?.size) pendingInterruptions.delete(run.id)
    } else if (pendingInterruptions.get(run.id)?.has(callId) || interrupted(resolution)) {
      const parts = pendingInterruptions.get(run.id) ?? new Map<string, ToolPart>()
      parts.set(callId, next)
      pendingInterruptions.set(run.id, parts)
    }
    return next
  }
  const planFinish = (run: Run, parts: MessagePart[], reason: Exclude<ToolResolution, "running">, persist = true) => {
    const rows = (getRunParts?.all(run.id) ?? []) as Array<StoredResolution & { call_id: string }>
    // Buffer the current run's resolutions locally, then persist them with one statement in the caller's transaction.
    const batch: ResolutionBatch | undefined = database
      ? { stored: new Map(rows.map((row) => [row.call_id, row])), writes: new Map(), cleared: new Set() }
      : undefined
    const result = parts.map((part) => {
      if (!isTool(part)) return part
      const current = record(run, part, true, persist, batch)
      return outcome(current) === "running"
        ? record(run, { ...current, resolution: reason, resolvedAt: Date.now() }, false, persist, batch)
        : current
    })
    const stored = [
      ...rows,
      ...Array.from(pendingInterruptions.get(run.id)?.values() ?? [], (part) => ({ part_json: JSON.stringify(part) })),
    ]
    const included = new Set(result.filter(isTool).map((part) => part.callId))
    for (const row of stored ?? []) {
      const part = JSON.parse(row.part_json) as ToolPart
      if (included.has(part.callId)) continue
      const resolution = outcome(part)
      result.push(
        record(
          run,
          {
            ...part,
            resolution: resolution === "running" ? reason : hasResult(resolution) ? "completed_unobserved" : resolution,
            ...(part.type === "file_change" && (resolution === "succeeded" || resolution === "failed")
              ? { completedOutcome: resolution }
              : {}),
            resolvedAt: part.resolvedAt ?? Date.now(),
          },
          false,
          persist,
          batch,
        ),
      )
    }
    const writes = Array.from(batch?.writes ?? [])
    const batches = Array.from({ length: Math.ceil(writes.length / 32) }, (_, index) => {
      const slice = writes.slice(index * 32, (index + 1) * 32)
      const placeholders = slice.map(() => "(?, ?, ?, ?, ?, ?)").join(",")
      const statement =
        database?.query(`INSERT INTO tool_resolutions(run_id, call_id, thread_id, part_json, resolution, resolved_at)
        VALUES ${placeholders} ON CONFLICT(run_id, call_id) DO UPDATE SET
          part_json = excluded.part_json, resolution = excluded.resolution, resolved_at = excluded.resolved_at
        WHERE tool_resolutions.part_json IS NOT excluded.part_json
          OR tool_resolutions.resolution IS NOT excluded.resolution
          OR tool_resolutions.resolved_at IS NOT excluded.resolved_at`)
      const bindings = slice.flatMap(([callId, row]) => [
        run.id,
        callId,
        run.threadId,
        row.part_json,
        row.resolution,
        row.resolved_at,
      ])

      return { statement, bindings }
    })
    return { parts: result, batch, batches, sourceRowsJson: JSON.stringify(rows) }
  }
  const saveFinish = (run: Run, plan: ReturnType<typeof planFinish>, reason: FinishReason): MessagePart[] => {
    // Each statement binds at most 32 rows; all statements stay in the terminal transaction.
    plan.batches.forEach(({ statement, bindings }) => {
      statement?.run(...bindings)
    })
    plan.batch?.cleared.forEach((callId) => {
      clearPendingPart(run.id, callId)
    })
    if (getPendingToolCall?.get(run.id))
      database
        ?.query(
          "UPDATE tool_calls SET ok = 0, error_code = ?, duration_ms = COALESCE(duration_ms, ? - created_at) WHERE run_id = ? AND ok IS NULL",
        )
        .run(reason.toUpperCase(), Date.now(), run.id)
    return plan.parts
  }
  const finish = (run: Run, parts: MessagePart[], reason: FinishReason, persist = true): MessagePart[] => {
    const plan = planFinish(run, parts, reason, persist)

    return persist ? saveFinish(run, plan, reason) : plan.parts
  }
  const prepareFinish = (run: Run, parts: MessagePart[], reason: FinishReason): PreparedToolFinish => {
    if (!database) return (current, currentReason) => finish(run, current, currentReason)

    const source = JSON.stringify(parts)
    const pending = Array.from(pendingInterruptions.get(run.id) ?? [])
    const plan = planFinish(run, parts, reason, true)
    const snapshot = structuredClone(plan.parts)

    return (current, currentReason) => {
      const interruptions = pendingInterruptions.get(run.id)
      const samePending =
        (interruptions?.size ?? 0) === pending.length &&
        pending.every(([callId, part]) => interruptions?.get(callId) === part)
      const sameRows = JSON.stringify(getRunParts?.all(run.id) ?? []) === plan.sourceRowsJson
      const sameSource = JSON.stringify(current) === source
      // Recheck the current run's durable rows and late cancellation inside the winning transaction.
      if (currentReason !== reason || !sameRows || !samePending || !sameSource)
        return finish(run, current, currentReason)

      saveFinish(run, plan, reason)
      return snapshot
    }
  }
  const clearPendingPart = (runId: string, callId: string): void => {
    const parts = pendingInterruptions.get(runId)
    parts?.delete(callId)
    if (!parts?.size) pendingInterruptions.delete(runId)
  }
  const clearPendingMemory = (runId: string): void => {
    pendingInterruptions.delete(runId)
  }
  const clearPending = (runId: string): void => {
    clearPendingMemory(runId)
    database?.query("DELETE FROM tool_recovery_pending WHERE run_id = ?").run(runId)
  }
  const getPendingRuns = (threadId?: string): RecoveryRun[] =>
    (database
      ?.query(`${PENDING_TOOL_RECOVERY_SQL} ${threadId ? "AND p.thread_id = ?" : ""} ORDER BY r.queued_at, r.id`)
      .all(...(threadId ? [threadId] : [])) ?? []) as RecoveryRun[]

  const finishAsync = async (
    run: Run,
    parts: MessagePart[],
    reason: Exclude<ToolResolution, "running">,
    persist = true,
    runStage?: PerformanceStageRunner,
  ): Promise<MessagePart[]> => {
    const result: MessagePart[] = []
    for (const [index, part] of parts.entries()) {
      // Small results may resolve through microtasks only; bound each live finalization slice explicitly.
      if (index > 0 && index % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      if (!isTool(part)) {
        result.push(part)
        continue
      }
      const current = await recordAsync(run, part, true, persist, runStage)
      result.push(
        outcome(current) === "running"
          ? await recordAsync(run, { ...current, resolution: reason, resolvedAt: Date.now() }, false, persist, runStage)
          : current,
      )
    }
    const stored = [
      ...((getRunParts?.all(run.id) as Array<{ part_json: string }> | undefined) ?? []),
      ...Array.from(pendingInterruptions.get(run.id)?.values() ?? [], (part) => ({ part_json: JSON.stringify(part) })),
    ]
    const included = new Set(result.filter(isTool).map((part) => part.callId))
    for (const row of stored) {
      const part = JSON.parse(row.part_json) as ToolPart
      if (included.has(part.callId)) continue
      const resolution = outcome(part)
      result.push(
        await recordAsync(
          run,
          {
            ...part,
            resolution: resolution === "running" ? reason : hasResult(resolution) ? "completed_unobserved" : resolution,
            ...(part.type === "file_change" && (resolution === "succeeded" || resolution === "failed")
              ? { completedOutcome: resolution }
              : {}),
            resolvedAt: part.resolvedAt ?? Date.now(),
          },
          false,
          persist,
          runStage,
        ),
      )
    }
    if (persist && getPendingToolCall?.get(run.id))
      database
        ?.query(
          "UPDATE tool_calls SET ok = 0, error_code = ?, duration_ms = COALESCE(duration_ms, ? - created_at) WHERE run_id = ? AND ok IS NULL",
        )
        .run(reason.toUpperCase(), Date.now(), run.id)
    return result
  }
  const reconcileRun = async (store: StoreApi, runId: string): Promise<void> => {
    if (!database) return
    const recovery = database.transaction(() => {
      const row = database.query(`${PENDING_TOOL_RECOVERY_SQL} AND p.run_id = ?`).get(runId) as RecoveryRun | null
      if (!row) return null
      // Calls can be persisted before the first assistant message is written.
      const message = database
        .query(`SELECT id, parts_json, status FROM messages
        WHERE thread_id = ? AND run_id = ? AND role = 'assistant' AND kind = 'text'
        ORDER BY id = ? DESC, created_at DESC LIMIT 1`)
        .get(row.thread_id, row.id, row.reply_message_id) as {
        id: string
        parts_json: string
        status: string
      } | null
      const parts = message ? (JSON.parse(message.parts_json) as MessagePart[]) : []
      const reason = terminalReason(row.status)
      const run = { id: row.id, threadId: row.thread_id } as Run
      return { row, message, parts, reason, run }
    })()
    if (!recovery) return
    const { row, message, parts, reason, run } = recovery
    // Finish durable file creation before the short, atomic projection repair.
    const next = await externalizeMessagePartsAsync({
      database,
      appData: kernel.paths.appData,
      parts: await finishAsync(run, parts, reason, false),
    })
    await writeDatabaseAsync(database, () =>
      database.transaction(() => {
        const current = message
          ? (database
              .query("SELECT parts_json, status FROM messages WHERE id = ? AND thread_id = ?")
              .get(message.id, row.thread_id) as { parts_json: string; status: string } | null)
          : null
        if (message && (!current || current.parts_json !== message.parts_json || current.status !== message.status))
          return

        const shouldUpdate =
          message && (JSON.stringify(parts) !== JSON.stringify(next) || message.status === "streaming")
        if (message && shouldUpdate) {
          const status: Message["status"] =
            row.status === "succeeded" ? "complete" : row.status === "canceled" ? "canceled" : "failed"
          // These parts already passed the complete file externalization plan above.
          const updated = store.updateMessage({
            threadId: row.thread_id,
            messageId: message.id,
            patch: { parts: next, status },
          })
          if (!updated.success) throw new Error(updated.error)
        }
        next.filter(isTool).forEach((part) => {
          saveResolution?.run(
            run.id,
            part.callId,
            run.threadId,
            JSON.stringify(part),
            outcome(part),
            part.resolvedAt ?? null,
          )
        })
        if (getPendingToolCall?.get(run.id))
          database
            .query(
              "UPDATE tool_calls SET ok = 0, error_code = ?, duration_ms = COALESCE(duration_ms, ? - created_at) WHERE run_id = ? AND ok IS NULL",
            )
            .run(reason.toUpperCase(), Date.now(), run.id)
        clearPending(row.id)
      })(),
    )
  }
  const reconcile = async (store: StoreApi, threadId?: string): Promise<void> => {
    for (const row of getPendingRuns(threadId)) {
      await reconcileRun(store, row.id)
    }
  }
  const reconcilePending = async (store: StoreApi, threadId: string): Promise<void> => {
    for (const row of getPendingRuns(threadId)) {
      await reconcileRun(store, row.id)
      // Live imports may introduce many completed turns; let other clients run between them.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return {
    record,
    recordAsync,
    finish,
    finishAsync,
    prepareFinish,
    reconcile,
    reconcilePending,
    clearPendingMemory,
    clearPending,
    summary: (store: StoreApi, threadId: string, leafId?: string) => {
      const summary = database ? summarizeToolResolutions(database, store, threadId, leafId) : null
      return summary ? kernel.redact(summary) : null
    },
  }
}

const hasSameStoredResolution = (
  stored: StoredResolution | null | undefined,
  next: StoredResolution,
  part: ToolPart,
): boolean => {
  if (!stored || stored.resolution !== next.resolution || stored.resolved_at !== next.resolved_at) return false
  if (stored.part_json === next.part_json) return true

  // Worker JSON can order keys differently; identical resolved values do not need another write.
  return isDeepStrictEqual(JSON.parse(stored.part_json), part)
}
