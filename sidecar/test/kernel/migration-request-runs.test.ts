import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const roots = new Set<string>()
const databases = new Set<ReturnType<typeof openDatabase>>()

afterEach(async () => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

test("schema 48 gains the ordered request index and preserves existing history indexes on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-request-migration-"))
  roots.add(root)
  const filename = join(root, "touri.db")
  const original = openTestDatabase(filename)
  original.exec("DROP INDEX IF EXISTS runs_request; UPDATE schema_meta SET value = '48' WHERE key = 'schema_version'")
  original.close()
  databases.delete(original)

  const upgraded = openTestDatabase(filename)
  const plan = upgraded
    .query(
      "EXPLAIN QUERY PLAN SELECT * FROM runs WHERE thread_id = ? AND request_message_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1",
    )
    .all("demo-thread", "demo-request")

  expect(upgraded.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
    value: "51",
  })
  expect(JSON.stringify(plan)).toContain("runs_request")
  expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE")
  expect(upgraded.query("SELECT name FROM sqlite_master WHERE name = 'messages_thread_created'").get()).toEqual({
    name: "messages_thread_created",
  })

  upgraded.close()
  databases.delete(upgraded)
  const reopened = openTestDatabase(filename)

  expect(reopened.query("SELECT name FROM sqlite_master WHERE name = 'runs_request'").get()).toEqual({
    name: "runs_request",
  })
  expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([])
})

const openTestDatabase = (filename: string) => {
  const database = openDatabase({ filename })
  databases.add(database)

  return database
}
