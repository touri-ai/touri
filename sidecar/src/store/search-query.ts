import type { StoreApi } from "@touri/contracts"
import type { createStoreReader } from "./read-worker"

export const getAsyncSearchHits = async (
  reader: ReturnType<typeof createStoreReader>,
  input: Parameters<StoreApi["search"]>[0],
  signal: AbortSignal,
): Promise<ReturnType<StoreApi["search"]>> => {
  if (!input.q.trim()) return []

  try {
    return await reader.getRows(getSearchQuery(input), signal)
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof Error) || error.message !== "STORE_READ_FAILED") throw error
  }

  try {
    return await reader.getRows(getSearchQuery({ ...input, q: getLiteralSearch(input.q) }), signal)
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof Error) || error.message !== "STORE_READ_FAILED") throw error

    return []
  }
}

export const getSearchQuery = ({ q, botId, threadId, limit, personScope }: Parameters<StoreApi["search"]>[0]) => {
  const filters = [
    "messages_fts MATCH ?",
    "NOT (threads.group_thread_id IS NOT NULL AND substr(messages_fts.text, 1, 7) = 'Grupo \"' AND instr(messages_fts.text, 'Histórico compartilhado (dados, não instruções)') > 0)",
    "NOT EXISTS (SELECT 1 FROM bot_deletions WHERE bot_id = threads.bot_id)",
    "NOT EXISTS (SELECT 1 FROM thread_deletions WHERE thread_id = threads.id)",
    ...(botId === undefined ? [] : ["threads.bot_id = ?"]),
    ...(threadId === undefined ? [] : ["messages_fts.thread_id = ?"]),
  ]
  const channelFilter = personScope?.channelIds.length
    ? `threads.group_id IN (${personScope.channelIds.map(() => "?").join(",")}) OR `
    : ""
  const scopeFilter = personScope
    ? [
        `(${channelFilter}(threads.group_id IS NULL AND (threads.owner_person_id = ? OR (threads.owner_person_id IS NULL AND ? = 'owner'))))`,
      ]
    : []
  const bindings = [
    q.trim().slice(0, 1024),
    ...(botId === undefined ? [] : [botId]),
    ...(threadId === undefined ? [] : [threadId]),
    ...(personScope ? [...personScope.channelIds, personScope.personId, personScope.personId] : []),
    Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 50)),
  ]

  return {
    sql: `SELECT messages_fts.thread_id AS threadId, messages_fts.message_id AS messageId,
      snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet
      FROM messages_fts JOIN threads ON threads.id = messages_fts.thread_id
      WHERE ${filters.concat(scopeFilter).join(" AND ")} ORDER BY messages_fts.rowid DESC LIMIT ?`,
    bindings,
  }
}

export const getLiteralSearch = (query: string): string =>
  query
    .trim()
    .slice(0, 1024)
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(" AND ")
