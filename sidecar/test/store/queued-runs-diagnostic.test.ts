import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const sql = await readFile(new URL("../../../scripts/diagnostics/queued-runs.sql", import.meta.url), "utf8")
const databases = new Set<Database>()
afterEach(() => {
  databases.forEach((db) => {
    db.close()
  })
  databases.clear()
})

const getFixture = () => {
  const db = new Database(":memory:")
  databases.add(db)
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, bot_id TEXT, status TEXT,
      queued_at INTEGER, started_at INTEGER, thread_id TEXT, reply_message_id TEXT);
    CREATE TABLE messages (id TEXT, thread_id TEXT, run_id TEXT, updated_at INTEGER,
      PRIMARY KEY (thread_id, id));
    CREATE TABLE group_turns (run_id TEXT PRIMARY KEY, group_id TEXT, recipients_json TEXT);
    CREATE TABLE group_run_links (run_id TEXT PRIMARY KEY, turn_id TEXT, depth INTEGER);
    INSERT INTO runs VALUES ('waiting', 'builder', 'queued', 10, NULL, 'conversation', NULL);`)
  return db
}

const addRun = (db: Database, id: string, bot: string, status = "running", thread = "conversation") =>
  db.query("INSERT INTO runs VALUES (?, ?, ?, 1, 2, ?, NULL)").run(id, bot, status, thread)
const addChannel = (db: Database, run: string, group = "channel", recipients = ["builder"]) =>
  db.query("INSERT INTO group_turns VALUES (?, ?, ?)").run(run, group, JSON.stringify(recipients))

test("channel wait identifies another bot's coordinator as the blocker", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "blocker", "designer")
  addChannel(db, "blocker", "channel", ["designer", "builder"])

  const rows = db.query(sql).all(20)

  expect(rows).toEqual([
    {
      run_id: "waiting",
      bot_id: "builder",
      queued_at: 10,
      wait_scope: "channel",
      blocker_run_id: "blocker",
      blocker_started_at: 2,
      blocker_last_progress_at: null,
    },
  ])
})

test("an unrelated channel and a provider child are not channel blockers", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "unrelated", "builder")
  addChannel(db, "unrelated", "other-channel")
  addRun(db, "provider-child", "builder")

  expect(db.query(sql).all(20)).toMatchObject([{ wait_scope: "channel", blocker_run_id: null }])
})

test("ordinary conversation wait ignores coordinators and other conversations", () => {
  const db = getFixture()
  addRun(db, "coordinator", "builder")
  addChannel(db, "coordinator")
  addRun(db, "other-bot", "designer", "running", "other-conversation")
  addRun(db, "provider", "builder", "starting")

  expect(db.query(sql).all(20)).toMatchObject([{ wait_scope: "thread", blocker_run_id: "provider" }])
})

test("finished work cannot block and the age threshold excludes fresh work", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "finished", "designer", "succeeded")
  addChannel(db, "finished")

  expect(db.query(sql).all(20)).toMatchObject([{ blocker_run_id: null }])
  expect(db.query(sql).all(10)).toEqual([])
})

test("a same-bot channel request identifies its coordinator rather than the provider child", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "a-provider-child", "builder")
  addRun(db, "z-coordinator", "builder")
  addChannel(db, "z-coordinator")

  const rows = db.query(sql).all(20)

  expect(rows).toEqual([
    {
      run_id: "waiting",
      bot_id: "builder",
      queued_at: 10,
      wait_scope: "channel",
      blocker_run_id: "z-coordinator",
      blocker_started_at: 2,
      blocker_last_progress_at: null,
    },
  ])
})

test("an independent active member cannot hide the coordinator sharing a recipient", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "a-independent", "designer")
  addChannel(db, "a-independent", "channel", ["designer"])
  addRun(db, "z-blocker", "builder")
  addChannel(db, "z-blocker")

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ wait_scope: "channel", blocker_run_id: "z-blocker" }])
})

test("independent channel recipients leave the blocker unknown", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "independent", "designer")
  addChannel(db, "independent", "channel", ["designer"])

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ wait_scope: "channel", blocker_run_id: null }])
})

test("the same bot executing in another conversation is not a thread blocker", () => {
  const db = getFixture()
  addRun(db, "a-independent", "builder", "running", "other-conversation")
  addRun(db, "z-blocker", "builder")

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ wait_scope: "thread", blocker_run_id: "z-blocker" }])
})

test("a live delegated member identifies its owning coordinator", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "coordinator", "designer")
  addChannel(db, "coordinator", "channel", ["designer"])
  addRun(db, "delegated", "builder", "starting", "member-conversation")
  db.query("INSERT INTO group_run_links VALUES (?, ?, ?)").run("delegated", "coordinator", 1)

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ wait_scope: "channel", blocker_run_id: "coordinator" }])
})

test("a finished delegation does not reserve an independent recipient", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "coordinator", "designer")
  addChannel(db, "coordinator", "channel", ["designer"])
  addRun(db, "delegated", "builder", "succeeded", "member-conversation")
  db.query("INSERT INTO group_run_links VALUES (?, ?, ?)").run("delegated", "coordinator", 1)

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: null }])
})

const saveReplyProgress = (db: Database, runId: string, updatedAt: number) => {
  db.query(`INSERT INTO messages (id, thread_id, run_id, updated_at)
    SELECT ?, thread_id, id, ? FROM runs WHERE id = ?`).run(`reply-${runId}`, updatedAt, runId)
  db.query("UPDATE runs SET reply_message_id = ? WHERE id = ?").run(`reply-${runId}`, runId)
}

test("an old channel wait exposes fresh progress from its blocking member", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "coordinator", "builder")
  addChannel(db, "coordinator")
  addRun(db, "member", "builder", "running", "participant")
  db.query("INSERT INTO group_run_links VALUES ('member', 'coordinator', 0)").run()
  saveReplyProgress(db, "member", 100)

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: "coordinator", blocker_started_at: 2, blocker_last_progress_at: 100 }])
})

test("ordinary waits expose their blocking execution's own reply progress", () => {
  const db = getFixture()
  addRun(db, "provider", "builder")
  saveReplyProgress(db, "provider", 100)

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: "provider", blocker_last_progress_at: 100 }])
})

test("channel progress excludes unrelated recipients and completed attempts", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "coordinator", "designer")
  addChannel(db, "coordinator", "channel", ["designer", "builder"])
  addRun(db, "other-recipient", "designer", "running", "designer-thread")
  addRun(db, "finished-attempt", "builder", "succeeded", "builder-thread")
  db.query(
    "INSERT INTO group_run_links VALUES ('other-recipient', 'coordinator', 0), ('finished-attempt', 'coordinator', 0)",
  ).run()
  saveReplyProgress(db, "other-recipient", 200)
  saveReplyProgress(db, "finished-attempt", 300)

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: "coordinator", blocker_last_progress_at: null }])
})

test("delegated blockers report the latest active attempt for the waiting recipient", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "coordinator", "designer")
  addChannel(db, "coordinator", "channel", ["designer"])
  addRun(db, "delegated", "builder", "running", "participant")
  db.query("INSERT INTO group_run_links VALUES ('delegated', 'coordinator', 1)").run()
  saveReplyProgress(db, "delegated", 100)

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: "coordinator", blocker_last_progress_at: 100 }])
})

test("unknown blockers have unknown start and progress timestamps", () => {
  const db = getFixture()

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: null, blocker_started_at: null, blocker_last_progress_at: null }])
})

test("a reply from a different thread or run cannot imply blocker progress", () => {
  const db = getFixture()
  addRun(db, "provider", "builder")
  db.query("UPDATE runs SET reply_message_id = 'shared-id' WHERE id = 'provider'").run()
  db.query(`INSERT INTO messages VALUES ('shared-id', 'other-thread', 'provider', 200),
    ('shared-id', 'conversation', 'different-run', 300)`).run()

  const rows = db.query(sql).all(20)

  expect(rows).toMatchObject([{ blocker_run_id: "provider", blocker_last_progress_at: null }])
})
