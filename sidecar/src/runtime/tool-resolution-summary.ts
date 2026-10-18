import type { Database } from "bun:sqlite"
import type { MessagePart, StoreApi, ToolResolution } from "@touri/contracts"
import { MESSAGE_PATH_CTE } from "../kernel/message-path"
import { bounded } from "./utils"

type ToolPart = Extract<MessagePart, { callId: string }>
type ResolutionRow = {
  run_id: string
  request_message_id: string | null
  part_json: string
  resolution: ToolResolution
}

const describe = (row: ResolutionRow): string => {
  const part = JSON.parse(row.part_json) as ToolPart
  const name = part.type === "tool_call" ? part.tool : part.type === "command" ? part.command : part.paths.join(", ")
  const detail = part.type === "tool_call" ? part.outputJson : part.type === "command" ? part.outputTail : part.diff
  const result =
    part.type === "tool_call"
      ? part.ok
      : part.type === "command"
        ? part.exitCode === null
          ? null
          : part.exitCode === 0
        : part.completedOutcome
          ? part.completedOutcome === "succeeded"
          : null
  const resultNote =
    row.resolution === "completed_unobserved"
      ? `; resultado: ${result === null ? "desconhecido" : result ? "sucesso" : "falha"}`
      : ""
  return `${JSON.stringify(bounded({ value: name, max: 120 }))} (${JSON.stringify(bounded({ value: part.callId, max: 120 }))}): ${row.resolution}${resultNote}${detail ? `; saída parcial/registrada: ${bounded({ value: detail, max: 350 })}` : ""}`
}

export const summarizeToolResolutions = (
  database: Database,
  store: StoreApi,
  threadId: string,
  leafId?: string,
): string | null => {
  if (store.getPathMessage) return getStoredSummary(database, store, threadId, leafId)

  const rows = database
    .query(`SELECT t.run_id, r.request_message_id, t.part_json, t.resolution
    FROM tool_resolutions t JOIN runs r ON r.id = t.run_id
    WHERE t.thread_id = ? AND r.status IN ('succeeded','failed','canceled','interrupted')
      AND t.resolution IN ('cancelled_by_user','interrupted_by_restart','completed_unobserved')
    ORDER BY r.queued_at, t.call_id`)
    .all(threadId) as ResolutionRow[]
  if (!rows.length) return null
  const path = store.activePath({ threadId, ...(leafId ? { leafId } : {}) })
  const messages = new Set(path.map((message) => message.id))
  const runs = new Set(path.map((message) => message.runId).filter(Boolean))
  const relevant = rows.filter(
    (row) => runs.has(row.run_id) || (row.request_message_id && messages.has(row.request_message_id)),
  )
  return getSummary(relevant)
}

const getStoredSummary = (database: Database, store: StoreApi, threadId: string, leafId?: string): string | null => {
  const targetId = leafId ?? store.getThread({ threadId })?.activeLeafId
  if (!targetId) return null
  // Sort compact locators first; at most 31 tool bodies cross the SQLite boundary.
  const rows = database
    .query(`${MESSAGE_PATH_CTE}, branch_runs AS (
    SELECT DISTINCT m.run_id FROM branch b JOIN messages m ON m.thread_id = ? AND m.id = b.id
    WHERE m.run_id IS NOT NULL
  ), latest AS (
    SELECT t.rowid AS row_id, r.queued_at, t.call_id
    FROM tool_resolutions t JOIN runs r ON r.id = t.run_id
    WHERE t.thread_id = ? AND r.status IN ('succeeded','failed','canceled','interrupted')
      AND t.resolution IN ('cancelled_by_user','interrupted_by_restart','completed_unobserved')
      AND (r.request_message_id IN (SELECT id FROM branch)
        OR t.run_id IN (SELECT run_id FROM branch_runs))
    ORDER BY r.queued_at DESC, t.call_id DESC LIMIT 31
  ) SELECT t.run_id, NULL AS request_message_id, t.part_json, t.resolution
    FROM latest l JOIN tool_resolutions t ON t.rowid = l.row_id
    ORDER BY l.queued_at DESC, l.call_id DESC`)
    .all(threadId, targetId, threadId, null, null, threadId, threadId) as ResolutionRow[]

  // Reverse only this query result, which is local to the bounded summary.
  return getSummary(rows.reverse())
}

const getSummary = (relevant: ResolutionRow[]): string | null => {
  if (!relevant.length) return null
  const latest = relevant.slice(-30)
  return [
    "[touri: reconciliação das ferramentas de turnos anteriores]",
    ...(relevant.length > latest.length ? ["Chamadas mais antigas estão disponíveis em history_read."] : []),
    ...latest.map(describe),
    "cancelled_by_user e interrupted_by_restart indicam ausência de resultado final observado; podem existir efeitos parciais. Verifique o estado antes de repetir. completed_unobserved preserva um resultado concluído que não apareceu na resposta anterior.",
  ].join("\n")
}
