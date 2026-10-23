import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const databases = new Set<Database>()
const roots = new Set<string>()
afterEach(async () => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
  await Promise.all(Array.from(roots).map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

test("schema 49 enables fast conversation without replaying earlier migrations and preserves opt-out", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-conversation-migration-"))
  roots.add(root)
  const filename = join(root, "touri.db")
  const original = openDatabase({ filename })
  original.exec(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('fixture','Fixture','codex','/fixture',1,1)",
  )
  original.exec(
    "ALTER TABLE bots DROP COLUMN fast_conversation; UPDATE schema_meta SET value='49' WHERE key='schema_version'",
  )
  original.close()

  const migrated = openDatabase({ filename })
  databases.add(migrated)

  expect(migrated.query("SELECT name,fast_conversation FROM bots").get()).toEqual({
    name: "Fixture",
    fast_conversation: 1,
  })
  expect(migrated.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "51" })
  migrated.exec("UPDATE bots SET fast_conversation=0")
  migrated.close()
  databases.delete(migrated)
  const reopened = openDatabase({ filename })
  databases.add(reopened)
  expect(reopened.query("SELECT fast_conversation FROM bots").get()).toEqual({ fast_conversation: 0 })
})
