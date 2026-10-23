import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

const cleanups = new Set<() => void>()
afterEach(() => {
  // Reverse only a fresh cleanup snapshot; the shared registry stays unchanged.
  Array.from(cleanups)
    .reverse()
    .forEach((cleanup) => {
      cleanup()
    })
  cleanups.clear()
})

// SQLite has no per-connection statement observer; this helper owns and restores
// the native-method spy, and forwards calls with their original receiver.
const getQueryRecorder = () => {
  const queries = spyOn(Database.prototype, "query")
  cleanups.add(() => {
    queries.mockRestore()
  })

  return () => queries.mock.calls.map(([sql]) => sql)
}

test("a current-store restart does not audit every foreign-key table", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-restart-budget-"))
  cleanups.add(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const filename = join(root, "touri.db")
  openDatabase({ filename }).close()
  const getQueries = getQueryRecorder()

  const reopened = openDatabase({ filename })
  cleanups.add(() => {
    reopened.close()
  })

  expect(getQueries()).not.toContain("PRAGMA foreign_key_check")
  expect(getQueries()).not.toContain("PRAGMA table_info(bots)")
  expect(reopened.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
})

test("a version 46 upgrade only applies the missing migrations", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-upgrade-budget-"))
  cleanups.add(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, "touri.db")
  const database = openDatabase({ filename })
  database.exec(`DROP TABLE automatic_resume_jobs;
    DELETE FROM schema_meta WHERE key IN ('automatic_resume_version','hot_read_indexes_version');
    DROP INDEX messages_thread_created;
    DROP INDEX messages_run_created;
    DROP INDEX work_journal_uncertain;
    DROP INDEX work_journal_effect_state;
    DROP INDEX group_message_links_message;
    DROP INDEX bot_groups_created;
    DROP INDEX threads_channel_updated;
    DROP INDEX runs_active_order;
    DROP INDEX runs_request;
    UPDATE schema_meta SET value='46' WHERE key='schema_version';`)
  database.close()
  const getQueries = getQueryRecorder()

  const upgraded = openDatabase({ filename })
  cleanups.add(() => upgraded.close())

  expect(getQueries().filter((sql) => sql === "PRAGMA table_info(bots)")).toHaveLength(1)
  expect(upgraded.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })
  expect(upgraded.query("SELECT 1 FROM automatic_resume_jobs LIMIT 1").get()).toBeNull()
  expect(upgraded.query("SELECT name FROM sqlite_schema WHERE name='runs_active_order'").get()).not.toBeNull()
  expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([])
})
