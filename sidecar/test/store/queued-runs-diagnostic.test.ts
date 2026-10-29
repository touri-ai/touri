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
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, bot_id TEXT, status TEXT, queued_at INTEGER, started_at INTEGER);
    CREATE TABLE group_turns (run_id TEXT PRIMARY KEY, group_id TEXT);
    INSERT INTO runs VALUES ('waiting', 'builder', 'queued', 10, NULL);`)
  return db
}

const addRun = (db: Database, id: string, bot: string, status = "running") =>
  db.query("INSERT INTO runs VALUES (?, ?, ?, 1, 2)").run(id, bot, status)
const addChannel = (db: Database, run: string, group = "channel") =>
  db.query("INSERT INTO group_turns VALUES (?, ?)").run(run, group)

test("channel wait identifies another bot's coordinator as the blocker", () => {
  const db = getFixture()
  addChannel(db, "waiting")
  addRun(db, "blocker", "designer")
  addChannel(db, "blocker")

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

test("ordinary bot wait ignores coordinators and other bots", () => {
  const db = getFixture()
  addRun(db, "coordinator", "builder")
  addChannel(db, "coordinator")
  addRun(db, "other-bot", "designer")
  addRun(db, "provider", "builder", "starting")

  expect(db.query(sql).all(20)).toMatchObject([{ wait_scope: "bot", blocker_run_id: "provider" }])
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
