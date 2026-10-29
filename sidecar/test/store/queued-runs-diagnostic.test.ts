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
      queued_at INTEGER, started_at INTEGER, thread_id TEXT);
    CREATE TABLE group_turns (run_id TEXT PRIMARY KEY, group_id TEXT, recipients_json TEXT);
    CREATE TABLE group_run_links (run_id TEXT PRIMARY KEY, turn_id TEXT, depth INTEGER);
    INSERT INTO runs VALUES ('waiting', 'builder', 'queued', 10, NULL, 'conversation');`)
  return db
}

const addRun = (db: Database, id: string, bot: string, status = "running", thread = "conversation") =>
  db.query("INSERT INTO runs VALUES (?, ?, ?, 1, 2, ?)").run(id, bot, status, thread)
const addChannel = (db: Database, run: string, group = "channel", recipients = ["builder"]) =>
  db.query("INSERT INTO group_turns VALUES (?, ?, ?)").run(run, group, JSON.stringify(recipients))

test("channel wait identifies another bot's coordinator as the blocker", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "blocker", "designer")
  addChannel(db, "blocker", "channel", ["designer", "builder"])

  const rows = db.query(sql).all(20)

  expect(rows).toEqual([
    { run_id: "waiting", bot_id: "builder", queued_at: 10, wait_scope: "channel", blocker_run_id: "blocker" },
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
    { run_id: "waiting", bot_id: "builder", queued_at: 10, wait_scope: "channel", blocker_run_id: "z-coordinator" },
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
