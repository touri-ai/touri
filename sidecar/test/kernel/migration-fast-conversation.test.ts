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
  expect(migrated.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "54" })
  migrated.exec("UPDATE bots SET fast_conversation=0")
  migrated.close()
  databases.delete(migrated)
  const reopened = openDatabase({ filename })
  databases.add(reopened)
  expect(reopened.query("SELECT fast_conversation FROM bots").get()).toEqual({ fast_conversation: 0 })
})

test.each(["47", "48", "49", "50"])(
  "schema %s also installs push storage and preserves fast conversation opt-out",
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), "touri-push-migration-"))
    roots.add(root)
    const filename = join(root, "touri.db")
    const original = openDatabase({ filename })
    original.exec(
      "INSERT INTO bots(id,name,provider,home_dir,fast_conversation,created_at,updated_at) VALUES ('fixture','Fixture','codex','/fixture',0,1,1)",
    )
    original.exec("DROP TABLE push_deliveries; DROP TABLE push_devices")
    original.query("UPDATE schema_meta SET value=? WHERE key='schema_version'").run(version)
    original.close()

    const migrated = openDatabase({ filename })
    databases.add(migrated)

    expect(migrated.query("SELECT fast_conversation FROM bots").get()).toEqual({ fast_conversation: 0 })
    expect(migrated.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "54" })
    expect(migrated.query("SELECT count(*) AS total FROM push_devices").get()).toEqual({ total: 0 })
    expect(migrated.query("SELECT count(*) AS total FROM push_deliveries").get()).toEqual({ total: 0 })
  },
)

test("schema 53 adds script defaults to existing routines and reopens idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-script-migration-"))
  roots.add(root)
  const filename = join(root, "touri.db")
  const original = openDatabase({ filename })
  original.exec(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('fixture','Fixture','codex','/fixture',1,1)",
  )
  original.exec(
    "INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at) VALUES('routine','fixture','Example','Report','*/5 * * * *','UTC',1,1)",
  )
  original.exec(
    "ALTER TABLE routines DROP COLUMN kind; ALTER TABLE routines DROP COLUMN command; ALTER TABLE routines DROP COLUMN cwd; ALTER TABLE routines DROP COLUMN env_file; UPDATE schema_meta SET value='53' WHERE key='schema_version'",
  )
  original.close()

  const upgraded = openDatabase({ filename })
  expect(upgraded.query("SELECT kind,command,cwd,env_file,cron FROM routines").get()).toEqual({
    kind: "bot",
    command: "",
    cwd: "",
    env_file: null,
    cron: "*/5 * * * *",
  })
  expect(
    JSON.stringify(
      upgraded
        .query(
          "EXPLAIN QUERY PLAN SELECT * FROM routine_runs WHERE routine_id = ? AND status IN ('running', 'scheduled')",
        )
        .all("routine"),
    ),
  ).toContain("routine_runs_dispatch")
  upgraded.close()
  const reopened = openDatabase({ filename })
  databases.add(reopened)

  expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([])
  expect(reopened.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "54" })
})
