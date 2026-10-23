import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Message, NotificationRecord, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { PENDING_NOTIFICATIONS_SQL } from "../../src/notify/store"
import { BOTS_SQL, init as initStore } from "../../src/store"
import { WORKSPACE_MESSAGES_SQL, WORKSPACE_RUNS_SQL } from "../../src/store/workspace-activity"

const plan = (db: Database, sql: string, ...bindings: number[]): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join("\n")

const seedHistory = (db: Database): void => {
  db.transaction(() => {
    for (let index = 0; index < 6; index++) {
      db.query(
        "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,'codex','/tmp/bot',1,1)",
      ).run(`bot-${index}`, `Bot ${index}`)
      db.query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?,?,'Main',1,1)").run(
        `thread-${index}`,
        `bot-${index}`,
      )
    }
    // Large output stays in historical messages; none belongs in the workspace response.
    const output = JSON.stringify([{ type: "tool_call", outputJson: "output ".repeat(300) }])
    db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6000)
      INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
      SELECT 'message-'||x, 'thread-'||(x%6), 'assistant', 'tool', 'complete', '', ?, x, x FROM n`).run(output)
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<24000)
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at)
      SELECT 'run-'||x, 'thread-'||(x%6), 'bot-'||(x%6), 'codex', 'user', 'succeeded', x, x FROM n`)
    db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<24000)
      INSERT INTO notifications(kind,level,bot_id,thread_id,title,body,created_at)
      SELECT 'done','info','bot-'||(x%6),'thread-'||(x%6),'Done',?,? FROM n`).run(output, Date.now())
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500000)
      INSERT INTO ui_event_log(at,event_json)
      SELECT x, json_object('type','fixture.event','sequence',x) FROM n`)
    const approval = JSON.stringify([
      { type: "approval", approvalId: "pending-request", request: "command", detail: "pwd", decision: "pending" },
    ])
    db.query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
      VALUES ('approval','thread-0','assistant','approval','complete','Approve command',?,0,0)`).run(approval)
    db.query(`INSERT INTO notifications(kind,level,bot_id,thread_id,title,body,request_id,created_at)
      VALUES ('approval','warning','bot-0','thread-0','Approve','Command','pending-request',?)`).run(Date.now())
    for (let index = 0; index < 6; index++) {
      db.query(`INSERT INTO messages(id,thread_id,role,kind,status,text,created_at,updated_at)
        VALUES (?,?,'assistant','text','complete','Latest reply',30000,30000)`).run(
        `latest-${index}`,
        `thread-${index}`,
      )
    }
  })()
}

test("hot endpoints stay responsive with 500000 events and seek indexed sidebar candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-hot-endpoints-"))
  const runtime = createKernel({ appData: root })
  try {
    await initStore(runtime.kernel)
    await initNotify(runtime.kernel)
    const db = runtime.kernel.db as Database
    seedHistory(db)
    expect((db.query("SELECT count(*) AS n FROM ui_event_log").get() as { n: number }).n).toBe(500000)

    const messagesPlan = plan(db, WORKSPACE_MESSAGES_SQL)
    for (const index of [
      "messages_visible_created",
      "messages_assistant_updated",
      "messages_assistant_settled",
      "messages_assistant_complete",
      "workspace_attention_pending",
      "notifications_pending_request",
    ])
      expect(messagesPlan).toContain(index)
    expect(messagesPlan).toMatch(/messages_(?:assistant|thread)_created/)
    expect(messagesPlan).not.toMatch(/\bSCAN m\b/)
    const runsPlan = plan(db, WORKSPACE_RUNS_SQL)
    expect(runsPlan).toContain("runs_active_workspace")
    expect(runsPlan).toContain("runs_thread")
    expect(runsPlan).not.toMatch(/\bSCAN r\b/)
    expect(plan(db, BOTS_SQL)).toContain("bots_live_order")
    expect(plan(db, PENDING_NOTIFICATIONS_SQL, Date.now() - 48 * 60 * 60 * 1000)).toContain("notifications_pending")

    const get = async <T>(path: string): Promise<{ elapsed: number; value: T }> => {
      const started = performance.now()
      const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
        headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
      })
      expect(response.status).toBe(200)
      const value = (await response.json()) as T
      return { elapsed: performance.now() - started, value }
    }
    const budgets = [
      ["/bots", 100],
      ["/workspace/activity", 200],
      ["/notifications/pending", 100],
    ] as const
    for (const [path, budget] of budgets) {
      const durations: number[] = []
      for (let attempt = 0; attempt < 3; attempt++) durations.push((await get(path)).elapsed)
      durations.sort((left, right) => left - right)
      const median = durations[1] ?? Number.POSITIVE_INFINITY
      console.info(`${path}: median ${median.toFixed(1)} ms; budget ${budget} ms; 500000 events`)
      expect(median).toBeLessThan(budget)
    }
    const bots = (await get<{ bots: Bot[] }>("/bots")).value
    expect(bots.bots).toHaveLength(6)
    const activity = (await get<{ messages: Message[]; runs: Run[] }>("/workspace/activity")).value
    expect(activity.messages).toHaveLength(7)
    expect(activity.runs).toHaveLength(6)
    expect(JSON.stringify(activity).length).toBeLessThan(15000)
    const pending = (await get<{ notifications: NotificationRecord[] }>("/notifications/pending")).value
    expect(pending.notifications.map((item) => item.requestId)).toEqual(["pending-request"])
  } finally {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
