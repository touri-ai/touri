import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { createRuntimePersistence, WORK_RUNS_SQL } from "../../src/runtime/persistence"
import { readWorkspaceActivity, WORKSPACE_RUNS_SQL } from "../../src/store/workspace-activity"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test.each(["running", "succeeded"] as const)("%s channel activity retains the member's coordination link", (status) => {
  const db = getDatabase(status)

  const activity = readWorkspaceActivity(db, { personId: "member", channelIds: ["team"] })

  expect(activity.runs).toHaveLength(2)
  expect(activity.runs.find((run) => run.id === "turn")).toMatchObject({
    threadId: "channel",
    kind: "coordination",
  })
  expect(activity.runs.find((run) => run.id === "turn")?.groupTurnId).toBeUndefined()
  expect(activity.runs.find((run) => run.id === "execution")).toMatchObject({
    threadId: "channel",
    groupTurnId: "turn",
    kind: "execution",
    status,
  })
  expect(readWorkspaceActivity(db, { personId: "outsider", channelIds: [] }).runs).toEqual([])
})

test("persisted work snapshots identify one execution under its channel turn", () => {
  const db = getDatabase("running")
  const persistence = createRuntimePersistence({ database: db })

  const snapshots = persistence.getRunSnapshots(["turn", "execution"])
  const work = persistence.listWorkRuns()

  expect(snapshots.find((run) => run.id === "turn")).toMatchObject({ kind: "coordination" })
  expect(snapshots.find((run) => run.id === "turn")?.groupTurnId).toBeUndefined()
  expect(snapshots.find((run) => run.id === "execution")).toMatchObject({
    threadId: "participant",
    groupThreadId: "channel",
    groupTurnId: "turn",
    kind: "execution",
  })
  expect(work).toHaveLength(1)
  expect(work[0]).toMatchObject({ id: "execution", groupTurnId: "turn", kind: "execution" })
  expect(persistence.getRun("turn")).toMatchObject({ kind: "coordination" })
  expect(persistence.listRuns("channel")[0]).toMatchObject({ kind: "coordination" })
  expect(persistence.listRuns("participant")[0]).toMatchObject({ kind: "execution" })
})

test.each(["running", "succeeded"] as const)("%s request replay derives run kinds without a warm cache", (status) => {
  const db = getDatabase(status)
  db.query("UPDATE runs SET request_message_id = ? WHERE id IN ('turn', 'execution')").run("request")
  const persistence = createRuntimePersistence({ database: db })

  const coordination = persistence.getRunForRequest({
    threadId: "channel",
    requestMessageId: "request",
    activeOnly: false,
  })
  const execution = persistence.getRunForRequest({
    threadId: "participant",
    requestMessageId: "request",
    activeOnly: false,
  })
  const active = persistence.getRunForRequest({ threadId: "channel", requestMessageId: "request" })
  const missing = persistence.getRunForRequest({ threadId: "channel", requestMessageId: "missing" })

  expect(coordination).toMatchObject({ id: "turn", kind: "coordination", status })
  expect(execution).toMatchObject({ id: "execution", kind: "execution", status })
  expect(active).toEqual(status === "running" ? coordination : null)
  expect(missing).toBeNull()
})

test("workspace run kinds use the coordination primary key instead of scanning history", () => {
  const db = getDatabase("running")

  const plan = db.query(`EXPLAIN QUERY PLAN ${WORKSPACE_RUNS_SQL}`).all() as { detail: string }[]

  expect(plan.some(({ detail }) => /SEARCH coordination .*\(run_id=\?\)/.test(detail))).toBe(true)
  expect(plan.some(({ detail }) => /SCAN coordination/.test(detail))).toBe(false)
})

test("a queued channel request stays in work before it has an execution", () => {
  const db = getDatabase("running")
  db.exec(`
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      VALUES ('waiting','channel','bot','codex','user','queued',3);
    INSERT INTO group_turns(run_id,group_id,recipients_json) VALUES ('waiting','team','["bot"]');
  `)
  const persistence = createRuntimePersistence({ database: db })

  const work = persistence.listWorkRuns()
  const plan = db.query(`EXPLAIN QUERY PLAN ${WORK_RUNS_SQL}`).all() as { detail: string }[]

  expect(work.map((run) => run.id)).toEqual(["execution", "waiting"])
  expect(work[1]).toMatchObject({ kind: "coordination", status: "queued", threadId: "channel", origin: "message" })
  expect(plan.some(({ detail }) => /runs_active_order/.test(detail))).toBe(true)
  expect(plan.some(({ detail }) => /SCAN (?:transcript_entries|messages|group_turns)/.test(detail))).toBe(false)
})

const getDatabase = (status: "running" | "succeeded") => {
  const root = mkdtempSync(join(tmpdir(), "touri-group-identity-"))
  const db = openDatabase({ filename: join(root, "test.db") })
  cleanups.add(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('bot','Demo','codex','/tmp/demo-bot',1,1);
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('team','Demo team','#888888','circle','demo',1,1);
    INSERT INTO threads(id,bot_id,title,group_id,group_thread_id,created_at,updated_at)
      VALUES ('channel','bot','Demo channel','team',NULL,1,1),
        ('participant','bot','Demo participant','team','channel',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,started_at)
      VALUES ('turn','channel','bot','codex','user','${status}',1,2),
        ('execution','participant','bot','codex','user','${status}',2,3);
    INSERT INTO group_turns(run_id,group_id,recipients_json) VALUES ('turn','team','["bot"]');
    INSERT INTO group_run_links(run_id,turn_id,depth) VALUES ('execution','turn',0);
  `)

  return db
}
