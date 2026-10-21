import type { Database } from "bun:sqlite"
import type { Id } from "@touri/contracts"

export type BrowserHandoff = {
  tabId: Id
  botId: Id | null
  threadId: Id | null
  runId: Id | null
  requestId: Id | null
  expiresAt: number
  state: "waiting" | "returned"
}

/** Store only control metadata. Browser input and page content never enter this ledger. */
export const createBrowserHandoffs = (database: Database) => {
  const get = (tabId: Id): BrowserHandoff | null =>
    database
      .query(`SELECT
    tab_id AS tabId, bot_id AS botId, thread_id AS threadId, run_id AS runId,
    request_id AS requestId, expires_at AS expiresAt, state
    FROM browser_pending_handoffs WHERE tab_id = ?`)
      .get(tabId) as BrowserHandoff | null

  const save = (handoff: BrowserHandoff): void => {
    database
      .query(`INSERT OR REPLACE INTO browser_pending_handoffs
      (tab_id,bot_id,thread_id,run_id,request_id,expires_at,state) VALUES (?,?,?,?,?,?,?)`)
      .run(
        handoff.tabId,
        handoff.botId,
        handoff.threadId,
        handoff.runId,
        handoff.requestId,
        handoff.expiresAt,
        handoff.state,
      )
  }

  const forget = (tabId: Id): void => {
    database.query("DELETE FROM browser_pending_handoffs WHERE tab_id = ?").run(tabId)
  }

  const resolve = (tabId: Id, resolution: "replied" | "expired" | "canceled"): void => {
    if (resolution !== "replied") {
      forget(tabId)
      return
    }
    database.query("UPDATE browser_pending_handoffs SET state = 'returned' WHERE tab_id = ?").run(tabId)
  }

  const hasReceipt = (runId: Id): boolean =>
    Boolean(database.query("SELECT 1 FROM browser_takeover_continuations WHERE previous_run_id = ? LIMIT 1").get(runId))

  return { get, save, forget, resolve, hasReceipt }
}
