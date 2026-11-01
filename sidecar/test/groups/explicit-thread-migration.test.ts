import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import migration from "../../src/kernel/migrations/explicit-threads.sql" with { type: "text" }

const databases: Database[] = []
afterEach(() => {
  databases.forEach((db) => {
    db.close()
  })
  databases.length = 0
})

test("existing new-thread routines migrate without modifying their prompts or schedule", () => {
  const db = new Database(":memory:")
  databases.push(db)
  db.exec(
    "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT, parent_id TEXT, role TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY, parent_thread_id TEXT, group_id TEXT, group_thread_id TEXT, archived_at INTEGER, created_at INTEGER); CREATE TABLE routines(id TEXT PRIMARY KEY, continuity TEXT, results_thread_id TEXT, prompt TEXT, cron TEXT);",
  )
  for (let index = 0; index < 8; index++)
    db.query("INSERT INTO routines VALUES (?, 'new-thread', NULL, 'Resumo diário', '0 9 * * *')").run(String(index))
  db.exec("INSERT INTO routines VALUES ('explicit-results', 'results-thread', 'existing', 'Revisar', '0 8 * * *')")

  db.exec(migration)

  expect(db.query("SELECT continuity, prompt, cron FROM routines WHERE id <> 'explicit-results'").all()).toEqual(
    Array.from({ length: 8 }, () => ({ continuity: "main-thread", prompt: "Resumo diário", cron: "0 9 * * *" })),
  )
  expect(db.query("SELECT continuity, results_thread_id FROM routines WHERE id='explicit-results'").get()).toEqual({
    continuity: "results-thread",
    results_thread_id: "existing",
  })
})

test("main-channel and anchor lookups use their bounded indexes", () => {
  const db = new Database(":memory:")
  databases.push(db)
  db.exec(
    "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT, parent_id TEXT, role TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY, parent_thread_id TEXT, group_id TEXT, group_thread_id TEXT, archived_at INTEGER, created_at INTEGER); CREATE TABLE routines(continuity TEXT, results_thread_id TEXT);",
  )
  db.exec(migration)

  const main = db
    .query(
      "EXPLAIN QUERY PLAN SELECT id FROM threads WHERE group_id = ? AND group_thread_id IS NULL AND parent_thread_id IS NULL AND archived_at IS NULL ORDER BY created_at, id LIMIT 1",
    )
    .all("channel")
  const anchor = db
    .query("EXPLAIN QUERY PLAN SELECT id FROM threads WHERE parent_thread_id = ? AND anchor_message_id = ?")
    .all("parent", "message")

  expect(JSON.stringify(main)).toContain("threads_channel_root")
  expect(JSON.stringify(main)).not.toContain("TEMP B-TREE")
  expect(JSON.stringify(anchor)).toContain("threads_anchor_message")
})
