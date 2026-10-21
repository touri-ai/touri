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

test("a published Work database gains deletion and handback tables despite the old marker", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`
    DROP TABLE thread_deletion_attachments;
    DROP TABLE thread_deletions;
    DROP INDEX threads_archived_page;
    DROP INDEX threads_group_thread;
    DROP TABLE browser_takeover_continuations;
    DELETE FROM schema_meta WHERE key = 'thread_deletion_version';
    UPDATE schema_meta SET value = '43' WHERE key = 'schema_version';
  `)

  const database = fixture.reopen()

  expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })
  expect(
    database
      .query(
        "SELECT name FROM sqlite_master WHERE name IN ('thread_deletions','browser_takeover_continuations') ORDER BY name",
      )
      .all(),
  ).toHaveLength(2)
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("a main database with a separate handback table also receives the Work continuation contract", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`
    DELETE FROM schema_meta WHERE key IN ('browser_channel_runs_version','browser_private_input_version','browser_bot_queue_version');
    DROP TABLE browser_request_runs;
    DROP TABLE browser_resume_requests;
    DROP TABLE browser_channel_runs;
    ALTER TABLE browser_tabs DROP COLUMN private_after_takeover;
    ALTER TABLE browser_tabs DROP COLUMN takeover_reason;
    ALTER TABLE browser_tabs DROP COLUMN private_input;
    ALTER TABLE browser_tabs DROP COLUMN private_document_ids_json;
    DROP TABLE run_continuations;
    CREATE TABLE run_continuations (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      original_run_id TEXT NOT NULL, previous_run_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('app_restart','provider_crash','permission_granted')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX run_continuations_original ON run_continuations(original_run_id);
    UPDATE schema_meta SET value = '38' WHERE key = 'schema_version';
  `)

  const database = fixture.reopen()
  const continuation = database.query("SELECT sql FROM sqlite_master WHERE name='run_continuations'").get() as {
    sql: string
  }

  expect(continuation.sql).toContain("browser_takeover")
  expect(
    database.query("SELECT name FROM sqlite_master WHERE name='browser_takeover_continuations'").get(),
  ).toBeTruthy()
  expect(
    database.query("SELECT name FROM pragma_table_info('browser_tabs') WHERE name='private_document_ids_json'").get(),
  ).toBeTruthy()
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
})
