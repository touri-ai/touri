import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import threadDeletionSql from "../../src/kernel/migrations/0045.sql" with { type: "text" }

const root = mkdtempSync(join(tmpdir(), "touri-main-browser-upgrade-"))
const filename = join(root, "test.db")
let database = new Database(filename)

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

test("upgrading the main thread-deletion schema preserves deletion records and adds browser state", async () => {
  for (const version of Array.from({ length: 36 }, (_, index) => index + 1)) {
    if (version === 33)
      database.exec(`
        ALTER TABLE bots ADD COLUMN responsible_person_id TEXT;
        ALTER TABLE threads ADD COLUMN owner_person_id TEXT;
        ALTER TABLE attachments ADD COLUMN owner_person_id TEXT;
      `)
    const sql = await Bun.file(
      join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
    ).text()
    database.exec(sql)
  }
  database.exec(threadDeletionSql)
  database.exec(`
    UPDATE schema_meta SET value = '37' WHERE key = 'schema_version';
    INSERT INTO thread_deletions(thread_id,bot_id,phase,created_at,updated_at)
      VALUES ('deleted-thread','bot','messages',1,1);
  `)
  database.close()

  database = openDatabase({ filename })

  expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })
  expect(database.query("SELECT thread_id, phase FROM thread_deletions").all()).toEqual([
    { thread_id: "deleted-thread", phase: "messages" },
  ])
  expect(
    database.query("SELECT name FROM pragma_table_info('browser_tabs') WHERE name = 'private_input'").get(),
  ).toEqual({
    name: "private_input",
  })
  expect(
    database.query("SELECT name FROM pragma_table_info('browser_channel_runs') WHERE name = 'resume_pending'").get(),
  ).toEqual({
    name: "resume_pending",
  })
})
