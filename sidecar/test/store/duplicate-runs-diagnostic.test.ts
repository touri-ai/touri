import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"

const sql = await Bun.file(new URL("../../../scripts/diagnostics/duplicate-runs.sql", import.meta.url)).text()
const databases = new Set<Database>()
afterEach(() => {
  databases.forEach((db) => {
    db.close()
  })
  databases.clear()
})

function getDatabase() {
  const db = new Database(":memory:")
  databases.add(db)
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, bot_id TEXT, thread_id TEXT,
      started_at INTEGER, trigger TEXT, request_message_id TEXT);
    CREATE TABLE group_turns (run_id TEXT PRIMARY KEY);
    CREATE TABLE group_run_links (run_id TEXT PRIMARY KEY, turn_id TEXT);
    INSERT INTO runs VALUES ('a', 'bot', 'channel', 2000, 'user', 'request');
    INSERT INTO runs VALUES ('b', 'bot', 'participant', 2700, 'user', 'request');
  `)
  return db
}

function getDuplicates(db: Database) {
  return db.query(sql).all(1000)
}

test.each(["a", "b"])("excludes coordination row %s on either side of the pair", (id) => {
  const db = getDatabase()
  db.query("INSERT INTO group_turns VALUES (?)").run(id)
  db.query("INSERT INTO group_run_links VALUES (?, ?)").run(id === "a" ? "b" : "a", id)

  const duplicates = getDuplicates(db)

  expect(duplicates).toEqual([])
})

test("detects two actual executions sharing a request", () => {
  const db = getDatabase()

  const duplicates = getDuplicates(db)

  expect(duplicates).toEqual([{ bot_id: "bot", first_run_id: "a", second_run_id: "b" }])
})

test("detects linked member executions even with different member message IDs", () => {
  const db = getDatabase()
  db.exec(`
    UPDATE runs SET request_message_id = id;
    INSERT INTO group_run_links VALUES ('a', 'turn'), ('b', 'turn');
  `)

  const duplicates = getDuplicates(db)

  expect(duplicates).toHaveLength(1)
})

test.each([
  "UPDATE runs SET request_message_id = id",
  "UPDATE runs SET request_message_id = NULL",
  "UPDATE runs SET bot_id = id",
  "UPDATE runs SET thread_id = 'same'",
  "UPDATE runs SET started_at = 500 WHERE id = 'a'",
  "UPDATE runs SET started_at = 3000 WHERE id = 'b'",
  "UPDATE runs SET trigger = 'routine' WHERE id = 'b'",
])("ignores unrelated or out-of-window work: %s", (update) => {
  const db = getDatabase()
  db.exec(update)

  const duplicates = getDuplicates(db)

  expect(duplicates).toEqual([])
})
