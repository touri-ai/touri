import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReportInput, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { buildReport } from "../../src/reports/bundle"

const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test.each(["queued", "running", "succeeded", "canceled"] as const)(
  "%s channel report identifies one coordination record and its execution from persisted relationships",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "touri-report-identity-"))
    const runtime = createKernel({ appData: root })
    cleanups.add(async () => {
      runtime.stop()
      await rm(root, { recursive: true, force: true })
    })
    const db = runtime.kernel.db as Database
    saveRuns(db, status)

    const snapshot = await buildReport(runtime.kernel, getReportInput())

    const records = [
      { id: "direct", kind: "execution", group_turn_id: null, provider_started_at: getProviderStartedAt(status) },
      {
        id: "member",
        kind: "execution",
        group_turn_id: "coordination",
        provider_started_at: getProviderStartedAt(status),
      },
      { id: "coordination", kind: "coordination", group_turn_id: null, provider_started_at: null },
    ]
    expect(snapshot.report.diagnostics).toMatchObject({ runs: records })
    const isActive = status === "queued" || status === "running"
    expect(snapshot.report.diagnostics).toMatchObject({
      states: {
        activeRuns: isActive ? expect.arrayContaining(records.map((record) => expect.objectContaining(record))) : [],
      },
    })
  },
)

const getProviderStartedAt = (status: Run["status"]): number | null => (status === "queued" ? null : 200)

const saveRuns = (db: Database, status: Run["status"]): void => {
  db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('bot','Demo','codex','/tmp',1,1);
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('team','Demo team','#112233','classic-none','team',1,1);
    INSERT INTO threads(id,bot_id,title,group_id,group_thread_id,created_at,updated_at)
      VALUES ('channel','bot','Demo channel','team',NULL,1,1),
        ('worker','bot','Demo worker','team','channel',1,1),
        ('direct','bot','Demo direct',NULL,NULL,1,1);`)
  const insert = db.query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,provider_started_at)
    VALUES (?,?,'bot','codex','user',?,?,?)`)
  insert.run("coordination", "channel", status, 100, null)
  insert.run("member", "worker", status, 101, getProviderStartedAt(status))
  insert.run("direct", "direct", status, 102, getProviderStartedAt(status))
  db.query("INSERT INTO group_turns VALUES ('coordination','team','[\"bot\"]')").run()
  db.query("INSERT INTO group_run_links VALUES ('member','coordination',0)").run()
}

const getReportInput = (): ReportInput => ({
  title: "Demo report",
  happened: "Demo task",
  expected: "One execution",
  steps: "Send one message",
  severity: "bug",
  botId: null,
  threadId: null,
  errorCode: null,
  parts: ["states", "runs"],
  images: [],
  repository: "",
})
