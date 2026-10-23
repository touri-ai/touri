import { Database } from "bun:sqlite"
import type { Run, StoreApi } from "@touri/contracts"
import { yieldBackground } from "../kernel/background-task"
import { toRun } from "./persistence"

/** The partial active-run index bounds restart discovery independently of terminal history. */
export const getStartupRuns = (database: unknown, getFallback: () => Run[]): AsyncGenerator<Run> => {
  const upper =
    database instanceof Database
      ? (database.query("SELECT COALESCE(MAX(rowid),0) AS rowid FROM runs").get() as { rowid: number }).rowid
      : 0
  const fallback = database instanceof Database ? [] : getFallback()

  return getStartupRunPages(database, upper, fallback)
}

export const getStartupReply = (store: StoreApi, run: Pick<Run, "threadId" | "replyMessageId">) => {
  if (!run.replyMessageId) return null
  if (store.getPathMessage)
    return store.getPathMessage({ threadId: run.threadId, messageId: run.replyMessageId, leafId: run.replyMessageId })

  return (
    store
      .activePath({ threadId: run.threadId, leafId: run.replyMessageId, limit: 1 })
      .find((message) => message.id === run.replyMessageId) ?? null
  )
}

async function* getStartupRunPages(database: unknown, upper: number, fallback: Run[]): AsyncGenerator<Run> {
  if (!(database instanceof Database)) {
    for (const run of fallback) {
      yield run
      await yieldBackground()
    }
    return
  }

  const page = database.query(`SELECT r.*, r.rowid AS cursor_rowid FROM runs r
    WHERE r.status IN ('queued','starting','running') AND r.queued_at >= ?
      AND r.rowid <= ?
      AND (r.queued_at > ? OR r.rowid > ?)
      AND r.id NOT IN (SELECT run_id FROM group_turns)
      AND (r.status <> 'queued' OR r.id IN (SELECT run_id FROM group_run_links))
    ORDER BY r.queued_at,r.rowid LIMIT 16`)
  // This generator owns its cursor; each resumed page seeks the existing active index.
  let queuedAt = 0
  let rowid = 0
  while (true) {
    const rows = page.all(queuedAt, upper, queuedAt, rowid) as Array<Record<string, unknown> & { cursor_rowid: number }>
    if (!rows.length) return

    for (const row of rows) {
      const run = toRun(row)
      if (!run) continue

      queuedAt = run.queuedAt
      rowid = row.cursor_rowid
      yield run
      await yieldBackground()
    }
  }
}
