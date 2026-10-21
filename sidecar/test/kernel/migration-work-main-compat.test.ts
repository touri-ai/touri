import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

const databases = new Set<Database>()
const roots = new Set<string>()
afterEach(async () => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-work-schema-"))
  roots.add(root)
  const filename = join(root, "test.db")
  const database = openDatabase({ filename })
  databases.add(database)
  const reopen = () => {
    database.close()
    databases.delete(database)
    const next = openDatabase({ filename })
    databases.add(next)

    return next
  }

  return { database, reopen }
}

test("a main database upgrades without replacing its handback and deletion tables", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`
    INSERT INTO browser_tabs(id,url,state,created_at,last_used_at,private_input,private_after_takeover)
      VALUES ('private-tab','','unloaded',1,1,1,1);
    ALTER TABLE browser_tabs DROP COLUMN private_document_ids_json;
    UPDATE schema_meta SET value = '45' WHERE key = 'schema_version';
  `)
  const handbackSchema = fixture.database
    .query("SELECT sql FROM sqlite_master WHERE name='browser_takeover_continuations'")
    .get()
  const deletionSchema = fixture.database.query("SELECT sql FROM sqlite_master WHERE name='thread_deletions'").get()

  const database = fixture.reopen()

  expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })
  expect(database.query("SELECT sql FROM sqlite_master WHERE name='browser_takeover_continuations'").get()).toEqual(
    handbackSchema,
  )
  expect(database.query("SELECT sql FROM sqlite_master WHERE name='thread_deletions'").get()).toEqual(deletionSchema)
  expect(database.query("SELECT private_document_ids_json FROM browser_tabs WHERE id='private-tab'").get()).toEqual({
    private_document_ids_json: "[0]",
  })
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("reopening Work preserves private document provenance and main's handback ledger", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`
    INSERT INTO browser_tabs(id,url,state,created_at,last_used_at,private_input,private_after_takeover,private_document_ids_json)
      VALUES ('private-tab','','unloaded',1,1,1,1,'[12,34]');
  `)

  const database = fixture.reopen()

  expect(database.query("SELECT private_document_ids_json FROM browser_tabs WHERE id='private-tab'").get()).toEqual({
    private_document_ids_json: "[12,34]",
  })
  expect(database.query("SELECT name FROM sqlite_master WHERE name='browser_pending_handoffs'").get()).toBeTruthy()
  expect(
    database.query("SELECT name FROM pragma_table_info('browser_channel_runs') WHERE name='current_run_id'").get(),
  ).toBeTruthy()
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
})
