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

test("existing stores gain a nullable tier and preserve its value across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-tier-migration-"))
  roots.add(root)
  const filename = join(root, "touri.db")
  const original = openDatabase({ filename })
  original.exec(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('fixture','Fixture','codex','/fixture',1,1)",
  )
  // Simulate the current schema before this additive migration.
  original.exec("DELETE FROM schema_meta WHERE key='bot_service_tier_version'")
  const columns = original.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
  if (columns.some((column) => column.name === "service_tier"))
    original.exec("ALTER TABLE bots DROP COLUMN service_tier")
  original.close()

  const migrated = openDatabase({ filename })
  databases.add(migrated)

  expect(migrated.query("SELECT name,service_tier FROM bots").get()).toEqual({ name: "Fixture", service_tier: null })
  migrated.exec("UPDATE bots SET service_tier='fast'")
  expect(() => migrated.exec("UPDATE bots SET service_tier='priority'")).toThrow()
  expect(() => migrated.exec("UPDATE bots SET provider='claude'")).toThrow()
  migrated.close()
  databases.delete(migrated)
  const reopened = openDatabase({ filename })
  databases.add(reopened)

  expect(reopened.query("SELECT service_tier FROM bots").get()).toEqual({ service_tier: "fast" })
  expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([])
})
