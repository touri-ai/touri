import { Database } from "bun:sqlite"
import type { Kernel, MessagePart, Run, StoreApi, ToolResolution } from "@touri/contracts"
import { externalizeMessageParts } from "../kernel/output-blobs"
import { summarizeToolResolutions } from "./tool-resolution-summary"

type ToolPart = Extract<MessagePart, { callId: string }>
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
  const getRunParts = database?.query("SELECT part_json FROM tool_resolutions WHERE run_id = ? ORDER BY rowid")
  const record = (run: Run, part: ToolPart, recovering = false, persist = true): ToolPart => {
    const previous =
      (getResolution?.get(run.id, part.callId) as {
        resolution: ToolResolution
        resolved_at: number | null
        part_json: string
      } | null) ?? null
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
    const resolved = {
      ...part,
      ...(keepResult ? resultPart : {}),
      resolution,
      ...(resolution === "completed_unobserved" && resultPart.type === "file_change" && completedOutcome !== undefined
        ? { completedOutcome }
        : {}),
      resolvedAt:
        resolution === "running"
          ? null
          : (part.resolvedAt ?? (previous?.resolution === resolution ? previous.resolved_at : null) ?? Date.now()),
    }
    const next = database
      ? (externalizeMessageParts({ database, appData: kernel.paths.appData, parts: [resolved] })[0] as ToolPart)
      : resolved
    if (persist)
      saveResolution?.run(run.id, part.callId, run.threadId, JSON.stringify(next), resolution, next.resolvedAt ?? null)
    return next
  }
  const finish = (run: Run, parts: MessagePart[], reason: Exclude<ToolResolution, "running">): MessagePart[] => {
    const result = parts.map((part) => {
      if (!isTool(part)) return part
      const current = record(run, part, true)
      return outcome(current) === "running"
        ? record(run, { ...current, resolution: reason, resolvedAt: Date.now() })
        : current
    })
    const stored = getRunParts?.all(run.id) as Array<{ part_json: string }> | undefined
    const included = new Set(result.filter(isTool).map((part) => part.callId))
    for (const row of stored ?? []) {
      const part = JSON.parse(row.part_json) as ToolPart
      if (included.has(part.callId)) continue
      const resolution = outcome(part)
      result.push(
        record(run, {
          ...part,
          resolution: resolution === "running" ? reason : hasResult(resolution) ? "completed_unobserved" : resolution,
          ...(part.type === "file_change" && (resolution === "succeeded" || resolution === "failed")
            ? { completedOutcome: resolution }
            : {}),
          resolvedAt: part.resolvedAt ?? Date.now(),
        }),
      )
    }
    database
      ?.query(
        "UPDATE tool_calls SET ok = 0, error_code = ?, duration_ms = COALESCE(duration_ms, ? - created_at) WHERE run_id = ? AND ok IS NULL",
      )
      .run(reason.toUpperCase(), Date.now(), run.id)
    return result
  }
  const clearPending = (runId: string): void => {
    database?.query("DELETE FROM tool_recovery_pending WHERE run_id = ?").run(runId)
  }
  const getPendingRuns = (threadId?: string): RecoveryRun[] =>
    (database
      ?.query(`${PENDING_TOOL_RECOVERY_SQL} ${threadId ? "AND p.thread_id = ?" : ""} ORDER BY r.queued_at, r.id`)
      .all(...(threadId ? [threadId] : [])) ?? []) as RecoveryRun[]

  const reconcileRun = (store: StoreApi, runId: string): void => {
    if (!database) return
    database.transaction(() => {
      const row = database.query(`${PENDING_TOOL_RECOVERY_SQL} AND p.run_id = ?`).get(runId) as RecoveryRun | null
      if (!row) return
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
      const next = finish(run, parts, reason)
      if (message && (JSON.stringify(parts) !== JSON.stringify(next) || message.status === "streaming")) {
        const updated = store.updateMessage({
          threadId: run.threadId,
          messageId: message.id,
          patch: {
            parts: next,
            status: row.status === "succeeded" ? "complete" : row.status === "canceled" ? "canceled" : "failed",
          },
        })
        if (!updated.success) throw new Error(updated.error)
      }
      clearPending(row.id)
    })()
  }
  const reconcile = (store: StoreApi, threadId?: string): void => {
    database?.transaction(() =>
      getPendingRuns(threadId).forEach((row) => {
        reconcileRun(store, row.id)
      }),
    )()
  }
  const reconcilePending = async (store: StoreApi, threadId: string): Promise<void> => {
    for (const row of getPendingRuns(threadId)) {
      reconcileRun(store, row.id)
      // Live imports may introduce many completed turns; let other clients run between them.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return {
    record,
    finish,
    reconcile,
    reconcilePending,
    clearPending,
    summary: (store: StoreApi, threadId: string, leafId?: string) => {
      const summary = database ? summarizeToolResolutions(database, store, threadId, leafId) : null
      return summary ? kernel.redact(summary) : null
    },
  }
}
