import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

const roots = new Set<string>()
const databases = new Set<Database>()

afterEach(() => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
  roots.forEach((root) => {
    rmSync(root, { recursive: true, force: true })
  })
  roots.clear()
})

const trackDatabase = (database: Database): Database => {
  databases.add(database)
  return database
}

const closeDatabase = (database: Database): void => {
  databases.delete(database)
  database.close()
}

const createSchema30 = async (filename: string): Promise<Database> => {
  const database = new Database(filename)
  database.exec("PRAGMA foreign_keys = ON")
  for (let version = 1; version <= 30; version++) {
    const migration = await Bun.file(
      join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
    ).text()
    database.exec(migration)
  }

  return database
}

test("schema 30 preserves run references and adds the group-context error class", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-group-context-error-migration-"))
  roots.add(root)
  const filename = join(root, "touri.db")
  let database = trackDatabase(await createSchema30(filename))
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('bot','Revisor','codex','/bot',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at)
      VALUES ('thread','bot','Conversa',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,error_message,queued_at)
      VALUES ('old-run','thread','bot','codex','user','failed','unknown','Falha anterior',1);
    INSERT INTO messages(id,thread_id,role,kind,status,run_id,text,created_at,updated_at)
      VALUES ('reply','thread','assistant','text','failed','old-run','Resposta anterior',1,1);
    INSERT INTO run_continuations(run_id,original_run_id,previous_run_id,reason,created_at)
      VALUES ('old-run','old-run','old-run','provider_crash',1);
  `)
  const oldRowid = database.query("SELECT rowid FROM runs WHERE id = 'old-run'").get()
  closeDatabase(database)

  database = trackDatabase(openDatabase({ filename }))

  expect(SCHEMA_VERSION).toBe(31)
  expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: "31" })
  expect(database.query("SELECT rowid FROM runs WHERE id = 'old-run'").get()).toEqual(oldRowid)
  expect(database.query("SELECT id,error_class,error_message FROM runs WHERE id = 'old-run'").get()).toEqual({
    id: "old-run",
    error_class: "unknown",
    error_message: "Falha anterior",
  })
  expect(database.query("SELECT run_id FROM run_continuations WHERE run_id = 'old-run'").get()).toEqual({
    run_id: "old-run",
  })
  expect(database.query("SELECT run_id FROM messages WHERE id = 'reply'").get()).toEqual({ run_id: "old-run" })

  database.exec(`
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,error_message,queued_at)
      VALUES ('orphan-run','thread','bot','codex','user','failed','group_context_missing','Conversa removida',2);
  `)
  expect(database.query("SELECT error_class FROM runs WHERE id = 'orphan-run'").get()).toEqual({
    error_class: "group_context_missing",
  })
  expect(database.query("SELECT run_id FROM tool_recovery_pending WHERE run_id = 'orphan-run'").get()).toEqual({
    run_id: "orphan-run",
  })
  expect(() =>
    database.exec(`
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,queued_at)
        VALUES ('invalid-run','thread','bot','codex','user','failed','not_a_run_error',3);
    `),
  ).toThrow()
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
  expect(
    database
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'runs' AND sql IS NOT NULL ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "runs_active_workspace" }, { name: "runs_status" }, { name: "runs_thread" }])
  closeDatabase(database)

  database = trackDatabase(openDatabase({ filename }))
  expect(database.query("SELECT error_class FROM runs WHERE id = 'orphan-run'").get()).toEqual({
    error_class: "group_context_missing",
  })
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
  closeDatabase(database)
})
