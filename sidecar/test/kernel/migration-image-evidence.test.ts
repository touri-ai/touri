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
