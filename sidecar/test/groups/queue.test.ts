import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { getPendingGroupBotIds } from "../../src/groups/queue"

const databases = new Set<Database>()
afterEach(() => {
  databases.forEach((db) => {
    db.close()
  })
  databases.clear()
})

const getDatabase = () => {
  const db = new Database(":memory:")
  databases.add(db)
  db.exec(`
    CREATE TABLE group_turns (run_id TEXT PRIMARY KEY, recipients_json TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, bot_id TEXT, status TEXT DEFAULT 'running');
    CREATE TABLE run_continuations (run_id TEXT PRIMARY KEY, original_run_id TEXT);
    CREATE INDEX run_continuations_original ON run_continuations(original_run_id);
    CREATE TABLE group_run_links (run_id TEXT PRIMARY KEY, turn_id TEXT, depth INTEGER);
    CREATE INDEX group_run_links_turn ON group_run_links(turn_id);
  `)
  db.query("INSERT INTO group_turns VALUES (?, ?)").run("shared", JSON.stringify(["planner", "reviewer"]))

  return db
}

test("pending bot snapshots survive reload and ignore delegated children", () => {
  const db = getDatabase()
  db.query("INSERT INTO runs(id, bot_id) VALUES (?, ?)").run("delegation", "planner")
  db.query("INSERT INTO group_run_links VALUES (?, ?, ?)").run("delegation", "shared", 1)
  db.query("INSERT INTO runs(id, bot_id) VALUES (?, ?)").run("member", "reviewer")
  db.query("INSERT INTO group_run_links VALUES (?, ?, ?)").run("member", "shared", 0)
  const run = { id: "shared", kind: "coordination" as const, status: "running" as const }

  const first = getPendingGroupBotIds(db, run)
  const reloaded = getPendingGroupBotIds(db, { ...run })

  expect(first).toEqual(["planner"])
  expect(reloaded).toEqual(first)
  expect(getPendingGroupBotIds(db, { ...run, status: "canceled" })).toEqual([])
  expect(getPendingGroupBotIds(db, { ...run, kind: "execution" })).toBeUndefined()
})

test("dispatch snapshot queries seek the turn index and run primary key", () => {
  const db = getDatabase()

  const plan = db
    .query(
      "EXPLAIN QUERY PLAN SELECT r.bot_id FROM group_run_links l JOIN runs r ON r.id = l.run_id WHERE l.turn_id = ? AND l.depth = 0",
    )
    .all("shared") as { detail: string }[]

  expect(plan.some((row) => row.detail.includes("group_run_links_turn"))).toBe(true)
  expect(plan.every((row) => !row.detail.includes("SCAN"))).toBe(true)
})

test("restart snapshots omit successful peers without hiding an interrupted recipient", () => {
  const db = getDatabase()
  db.query("INSERT INTO run_continuations VALUES (?, ?)").run("shared", "previous")
  db.query("INSERT INTO runs VALUES (?, ?, ?)").run("completed", "reviewer", "succeeded")
  db.query("INSERT INTO runs VALUES (?, ?, ?)").run("interrupted", "planner", "interrupted")
  db.query("INSERT INTO group_run_links VALUES (?, ?, ?)").run("completed", "previous", 0)
  db.query("INSERT INTO group_run_links VALUES (?, ?, ?)").run("interrupted", "previous", 0)

  const pending = getPendingGroupBotIds(db, { id: "shared", kind: "coordination", status: "running" })

  expect(pending).toEqual(["planner"])
})
