import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("0012 upgrades a copy of a populated schema 11 database, preserving rows, indexes, triggers and inbound FKs", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-opencode-upgrade-"))
  const original = join(root, "fixture.db")
  const filename = join(root, "upgraded.db")
  let db = new Database(original)
  try {
    db.exec("PRAGMA foreign_keys = ON")
    for (let n = 1; n <= 11; n++)
      db.exec(
        await Bun.file(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`)).text(),
      )
    db.exec(`
      INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('p','Projeto','/project','/data',1,1);
      INSERT INTO bots(id,name,provider,home_dir,project_id,machine,avatar_shape,role_line,cloud_target,created_at,updated_at) VALUES
        ('c','Codex','codex','/codex','p','local','nuage','Pesquisa',0,1,2), ('a','Claude','claude','/claude','p','vm','nuage','Código',1,3,4);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','c','Conversa',1,1);
      INSERT INTO provider_sessions(id,thread_id,provider,external_session_id,fingerprint,state,created_at,last_used_at) VALUES ('s','t','codex','native','fp','active',1,2);
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','c','codex','user','succeeded',1);
      INSERT INTO messages(id,thread_id,role,kind,text,run_id,created_at,updated_at) VALUES ('m','t','assistant','text','Histórico preservado','r',1,1);
      INSERT INTO bot_machines(bot_id,vm_id,volume) VALUES ('a','machine','volume');
      INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,coordinator_bot_id,created_at,updated_at) VALUES ('g','Grupo','#000','nuage','seed','c',1,1);
      INSERT INTO group_members(group_id,bot_id,position) VALUES ('g','c',0),('g','a',1);
      INSERT INTO cloud_machines VALUES ('a','https://cloud.example','account','remote',2);
      CREATE INDEX fixture_bots_provider ON bots(provider,name);
      CREATE TRIGGER fixture_bots_name AFTER UPDATE OF name ON bots BEGIN UPDATE settings SET value_json='true' WHERE key='experimentalTools'; END;
    `)
    const tables = (
      db
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    // Later migrations add columns; rows are compared on the columns the old schema had.
    const columns = new Map(
      tables.map((table) => [
        table,
        (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((column) => `"${column.name}"`)
          .join(", "),
      ]),
    )
    const before = new Map(
      tables.map((table) => [table, db.query(`SELECT ${columns.get(table)} FROM ${table} ORDER BY 1`).all()]),
    )
    const fks = new Map(tables.map((table) => [table, db.query(`PRAGMA foreign_key_list(${table})`).all()]))
    db.close()
    copyFileSync(original, filename)
    db = openDatabase({ filename })
    for (let reopen = 0; reopen < 2; reopen++) {
      for (const table of tables) {
        expect(
          db
            .query(
              `SELECT ${columns.get(table)} FROM ${table} ${table === "settings" ? "WHERE key NOT LIKE 'memory-trust:%'" : ""} ORDER BY 1`,
            )
            .all(),
        ).toEqual(before.get(table) ?? [])
        expect(db.query(`PRAGMA foreign_key_list(${table})`).all()).toEqual(fks.get(table) ?? [])
      }
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
      expect(db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      })
      expect(
        db
          .query(
            "SELECT name FROM sqlite_schema WHERE name IN ('fixture_bots_provider','fixture_bots_name','provider_sessions_active')",
          )
          .all(),
      ).toHaveLength(3)
      db.close()
      db = openDatabase({ filename })
    }
    expect(
      (
        db.query("SELECT key, value_json FROM settings WHERE key LIKE 'memory-trust:%' ORDER BY key").all() as Array<{
          key: string
          value_json: string
        }>
      ).map((row) => [row.key, JSON.parse(row.value_json)]),
    ).toEqual([
      ["memory-trust:a", { access: "workspace-write", machine: "cloud", review: false, hash: "" }],
      ["memory-trust:c", { access: "workspace-write", machine: "local", review: false, hash: "" }],
    ])
    db.exec(
      "UPDATE bots SET provider='opencode' WHERE id='c'; UPDATE provider_sessions SET provider='opencode' WHERE id='s'",
    )
    expect(() =>
      db.exec(
        "INSERT INTO provider_sessions SELECT 'duplicate',thread_id,provider,'other',NULL,fingerprint,state,model,created_at,last_used_at FROM provider_sessions WHERE id='s'",
      ),
    ).toThrow()
    expect(() => db.exec("UPDATE bots SET provider='unknown' WHERE id='c'")).toThrow()
    const fixture = new Database(original, { readonly: true })
    expect(fixture.query("SELECT provider FROM bots WHERE id='c'").get()).toEqual({ provider: "codex" })
    fixture.close()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
