import type { Database } from "bun:sqlite"
import type { BrowserTabInfo, Id, Kernel } from "@touri/contracts"
import type { SavedSecret } from "../approvals/secrets"
import { sanitizeHumanTakeoverUrl } from "./takeover-privacy"
import type { BrowserTabRow, TabState } from "./types"

type SecretRow = {
  id: string
  name: string
  updated_at: number
  keychain_account: string
  usage_json: string
  browser_origin: string | null
  project_id: string | null
}

const toInfo = (row: BrowserTabRow): TabState["info"] => ({
  tabId: row.id,
  url: row.url,
  title: row.title,
  state: row.state,
  openerTabId: row.opener_tab_id,
  heldByUser: row.held_by_user === 1,
  takeoverReason: row.takeover_reason,
  lastUsedAt: row.last_used_at,
  ownerBotId: row.owner_bot_id,
  ownerThreadId: row.owner_thread_id,
})

const toRow = (tab: TabState, createdAt: number): BrowserTabRow => ({
  id: tab.info.tabId,
  profile: "default",
  owner_bot_id: tab.info.ownerBotId,
  owner_thread_id: tab.info.ownerThreadId,
  opener_tab_id: tab.info.openerTabId,
  cdp_target_id: tab.targetId,
  url: tab.privateAfterTakeover ? sanitizeHumanTakeoverUrl(tab.info.url) : tab.info.url,
  title: tab.privateAfterTakeover ? "" : tab.info.title,
  state: tab.info.state,
  held_by_user: tab.info.heldByUser ? 1 : 0,
  private_after_takeover: tab.privateAfterTakeover ? 1 : 0,
  takeover_reason: tab.takeoverReason,
  private_input: tab.privateInput ? 1 : 0,
  created_at: createdAt,
  last_used_at: tab.info.lastUsedAt,
})

export type BrowserStore = {
  dispose: () => void
  load: () => Array<TabState>
  create: (args: { botId: Id; threadId: Id; url: string; openerTabId: Id | null; targetId: string | null }) => TabState
  save: (tab: TabState) => void
  update: (args: { tab: TabState; targetId: string | null }) => void
  find: (tabId: Id) => TabState | null
  list: (botId: Id | null) => Array<TabState>
  secretAccount: (args: { name: string; projectId: Id | null; origin: string }) => string | null
  secretReference: (args: { name: string; projectId: Id | null; origin: string }) => SavedSecret | null
}

export const createBrowserStore = ({
  kernel,
  profile = "default",
  retainTargets = false,
}: {
  kernel: Kernel
  profile?: string
  retainTargets?: boolean
}): BrowserStore => {
  const database = kernel.db as Database
  const tabs = new Map<Id, TabState>()
  let disposed = false

  const load = (): Array<TabState> => {
    // Older releases saved holds without a deadline; release them without exposing the private page or resuming work.
    database
      .query(`UPDATE browser_tabs
        SET held_by_user = 0, takeover_reason = NULL, private_after_takeover = 1, private_input = 1
        WHERE profile = ? AND held_by_user = 1 AND NOT EXISTS (
          SELECT 1 FROM browser_pending_handoffs handoff WHERE handoff.tab_id = browser_tabs.id AND handoff.state = 'waiting'
        )`)
      .run(profile)
    database
      .query(
        `UPDATE browser_tabs SET state = 'unloaded'${retainTargets ? "" : ", cdp_target_id = NULL"} WHERE state = 'live' AND profile = ?`,
      )
      .run(profile)
    const rows = database
      .query<BrowserTabRow, [string]>(
        "SELECT * FROM browser_tabs WHERE state != 'closed' AND profile = ? ORDER BY created_at",
      )
      .all(profile)
    const loaded = rows.map((row) => {
      const tab: TabState = {
        info: toInfo(row),
        targetId: retainTargets && row.owner_bot_id ? row.cdp_target_id : null,
        sessionId: null,
        frameSessions: new Map(),
        generation: 0,
        refs: new Map(),
        actions: [],
        diagnostics: [],
        navigationVersion: 0,
        secretMode: false,
        privateAfterTakeover: row.private_after_takeover === 1,
        takeoverReason: row.takeover_reason,
        privateInput: row.private_input === 1,
        dialog: null,
        lastFailureKey: null,
        failureCount: 0,
        queue: Promise.resolve(),
        handbackNote: null,
        takeover: null,
        lastSnapshot: null,
        mainDocument: null,
      }
      tabs.set(tab.info.tabId, tab)
      return tab
    })
    return loaded
  }

  const create = ({
    botId,
    threadId,
    url,
    openerTabId,
    targetId,
  }: {
    botId: Id
    threadId: Id
    url: string
    openerTabId: Id | null
    targetId: string | null
  }): TabState => {
    const now = Date.now()
    const tabId = `t_${kernel.newId()}`
    const info: TabState["info"] = {
      tabId,
      url,
      title: "",
      state: targetId === null ? "unloaded" : "live",
      openerTabId,
      heldByUser: false,
      takeoverReason: null,
      lastUsedAt: now,
      ownerBotId: botId,
      ownerThreadId: getExistingThreadId(database, threadId),
    }
    const tab: TabState = {
      info,
      targetId,
      sessionId: null,
      frameSessions: new Map(),
      generation: 0,
      refs: new Map(),
      actions: [],
      diagnostics: [],
      navigationVersion: 0,
      secretMode: false,
      privateAfterTakeover: false,
      takeoverReason: null,
      privateInput: false,
      dialog: null,
      lastFailureKey: null,
      failureCount: 0,
      queue: Promise.resolve(),
      handbackNote: null,
      takeover: null,
      lastSnapshot: null,
      mainDocument: null,
    }
    database
      .query(
        "INSERT INTO browser_tabs (id, profile, owner_bot_id, owner_thread_id, opener_tab_id, cdp_target_id, url, title, state, held_by_user, private_input, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 0, 0, ?, ?)",
      )
      .run(tabId, profile, botId, info.ownerThreadId, openerTabId, targetId, url, info.state, now, now)
    tabs.set(tabId, tab)
    return tab
  }

  const save = (tab: TabState): void => {
    if (disposed) return
    // A deleted conversation can leave a stale owner in a live browser tab.
    const thread = tab.info.ownerThreadId
      ? database.query<{ id: Id }, [Id]>("SELECT id FROM threads WHERE id = ?").get(tab.info.ownerThreadId)
      : null
    tab.info = { ...tab.info, ownerThreadId: thread?.id ?? null }
    const row = toRow(tab, Date.now())
    tab.info.lastUsedAt = row.last_used_at
    database
      .query(
        "UPDATE browser_tabs SET owner_bot_id = ?, owner_thread_id = ?, opener_tab_id = ?, cdp_target_id = ?, url = ?, title = ?, state = ?, held_by_user = ?, private_after_takeover = ?, takeover_reason = ?, private_input = ?, last_used_at = ? WHERE id = ?",
      )
      .run(
        row.owner_bot_id,
        row.owner_thread_id,
        row.opener_tab_id,
        row.cdp_target_id,
        row.url,
        row.title,
        row.state,
        row.held_by_user,
        row.private_after_takeover,
        row.takeover_reason,
        row.private_input,
        row.last_used_at,
        row.id,
      )
  }

  const update = ({ tab, targetId }: { tab: TabState; targetId: string | null }): void => {
    tab.targetId = targetId
    save(tab)
  }

  const find = (tabId: Id): TabState | null => tabs.get(tabId) ?? null

  const list = (botId: Id | null): Array<TabState> =>
    [...tabs.values()].filter((tab) => tab.info.state !== "closed" && (botId === null || tab.info.ownerBotId === botId))

  const secretReference = ({
    name,
    projectId,
    origin,
  }: {
    name: string
    projectId: Id | null
    origin: string
  }): SavedSecret | null => {
    const rows = database
      .query<SecretRow, [string, string | null]>(
        "SELECT id, name, updated_at, keychain_account, usage_json, browser_origin, project_id FROM secrets WHERE name = ? AND (project_id = ? OR project_id IS NULL) ORDER BY project_id IS NULL",
      )
      .all(name, projectId)
    for (const row of rows) {
      let usage: unknown
      try {
        usage = JSON.parse(row.usage_json) as unknown
      } catch {
        continue
      }
      if (typeof usage !== "object" || usage === null || !("browser" in usage) || usage.browser !== true) continue
      if (row.browser_origin === origin)
        return { id: row.id, name: row.name, account: row.keychain_account, revision: row.updated_at }
    }
    return null
  }

  const secretAccount: BrowserStore["secretAccount"] = (args) => secretReference(args)?.account ?? null
  return {
    load,
    create,
    save,
    update,
    find,
    list,
    secretAccount,
    secretReference,
    dispose: () => {
      disposed = true
    },
  }
}

export const publicTabInfo = ({ tab }: { tab: TabState }): BrowserTabInfo & { ownerBotId: Id | null } => ({
  tabId: tab.info.tabId,
  url: tab.info.url,
  title: tab.info.title,
  state: tab.info.state,
  openerTabId: tab.info.openerTabId,
  heldByUser: tab.info.heldByUser,
  takeoverReason: tab.takeoverReason,
  takeoverRequested: tab.takeover !== null,
  takeoverRunId: tab.takeover?.runId ?? null,
  lastUsedAt: tab.info.lastUsedAt,
  ownerBotId: tab.info.ownerBotId,
})

const getExistingThreadId = (database: Database, threadId: Id | null): Id | null => {
  if (!threadId) return null

  return database.query<{ id: Id }, [Id]>("SELECT id FROM threads WHERE id = ?").get(threadId)?.id ?? null
}
