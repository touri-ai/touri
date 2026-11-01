import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("current stores gain image lookup indexes once without replaying history migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-image-index-"))
  const filename = join(root, "touri.db")
  const original = openDatabase({ filename })
  original.exec(
    "DROP INDEX attachments_origin_path; DROP INDEX attachments_path; DELETE FROM schema_meta WHERE key='image_evidence_indexes_version'",
  )
  original.close()
  const database = openDatabase({ filename })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  const originPlan = database
    .query("EXPLAIN QUERY PLAN SELECT id,path FROM attachments WHERE origin_path = ?")
    .all("screen.png")
  const pathPlan = database.query("EXPLAIN QUERY PLAN SELECT id,path FROM attachments WHERE path = ?").all("screen.png")
  const refsPlan = database
    .query("EXPLAIN QUERY PLAN SELECT thread_id FROM attachment_message_refs WHERE attachment_id = ?")
    .all("demo")

  expect(JSON.stringify(originPlan)).toContain("attachments_origin_path")
  expect(JSON.stringify(pathPlan)).toContain("attachments_path")
  expect(JSON.stringify(refsPlan)).toContain("attachment_message_refs_attachment")
  expect(database.query("SELECT value FROM schema_meta WHERE key='image_evidence_indexes_version'").get()).toEqual({
    value: "1",
  })
})

test("current stores index assistant image references without rewriting historical messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-response-image-index-"))
  const filename = join(root, "touri.db")
  const original = openDatabase({ filename })
  original.exec(
    "DELETE FROM schema_meta WHERE key='response_image_references_version'; DROP TRIGGER messages_attachment_refs_insert; DROP TRIGGER messages_attachment_refs_update",
  )
  original.close()
  const database = openDatabase({ filename })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  const trigger = database
    .query("SELECT sql FROM sqlite_schema WHERE name = 'messages_attachment_refs_insert'")
    .get() as { sql: string }

  expect(trigger.sql).toContain("'$.images'")
  expect(database.query("SELECT value FROM schema_meta WHERE key='response_image_references_version'").get()).toEqual({
    value: "1",
  })
  expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
})
