import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEPRECATED_IMPORT_ALIAS } from "../../src/importer/deprecatedAliases"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

const OLD = DEPRECATED_IMPORT_ALIAS
const SOURCE_TABLES = ["bots", "threads", "messages", "routines"]

const migrationSql = async (n: number): Promise<string> => {
  const text = await Bun.file(
    join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`),
  ).text()

  return text.replaceAll("'legacy'", `'${OLD}'`)
}

const buildSchema13 = async (db: Database): Promise<void> => {
  db.exec("PRAGMA foreign_keys = ON")
  for (let n = 1; n <= 11; n++) db.exec(await migrationSql(n))
  db.exec("PRAGMA foreign_keys = OFF")
  db.exec(await migrationSql(12))
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(await migrationSql(13))
  db.exec("UPDATE schema_meta SET value = '13' WHERE key = 'schema_version'")
}

const seed = (db: Database): void => {
  db.exec(`
    INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('p','Projeto','/project','/data',1,1);
    INSERT INTO bots(id,name,provider,home_dir,project_id,source,created_at,updated_at) VALUES
      ('b-local','Local','codex','/local','p','local',1,2),
      ('b-old','Imported','claude','/imported','p','${OLD}',3,4);
    INSERT INTO threads(id,bot_id,title,source,created_at,updated_at) VALUES
      ('t-local','b-local','Local chat','local',1,1),
      ('t-old','b-old','Imported chat','${OLD}',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t-old','b-old','claude','import','succeeded',1);
    INSERT INTO messages(id,thread_id,role,kind,text,run_id,source,created_at,updated_at) VALUES
      ('m1','t-local','user','text','hello','r','local',1,1),
      ('m2','t-old','assistant','text','imported history','r','${OLD}',2,2),
      ('m3','t-old','user','text','imported question',NULL,'${OLD}',3,3);
    INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,source,created_at,updated_at) VALUES
      ('ro-old','b-old','Daily','prompt','0 9 * * *','America/Sao_Paulo','${OLD}',1,1),
      ('ro-local','b-local','Weekly','prompt','0 9 * * 1','America/Sao_Paulo','local',1,1);
    INSERT INTO imports(id,source,origin,status,started_at) VALUES ('imp','${OLD}','/legacy/app','succeeded',1);
    INSERT INTO import_records(source,source_kind,source_id,local_id,content_hash,import_id,imported_at) VALUES
      ('${OLD}','bot','src-bot','b-old','h1','imp',1),
      ('${OLD}-identity-v1','bot','["/legacy/app","bot","src-bot"]','b-old','','imp',1);
    INSERT INTO settings(key,value_json,updated_at) VALUES ('imports.${OLD}.expiry.cursor','7',1);
    CREATE INDEX fixture_threads_title ON threads(title);
    CREATE TRIGGER fixture_routines_name AFTER UPDATE OF name ON routines BEGIN UPDATE settings SET value_json='1' WHERE key='fixture'; END;
  `)
}

type Snapshot = { rows: Map<string, Array<unknown>>; fks: Map<string, Array<unknown>> }

// Later migrations add columns; rows are compared on the columns the old schema had.
const columnsOf = (db: Database, table: string): Array<string> =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => `"${column.name}"`)

const snapshot = (db: Database, tables: Array<string>, columns?: Map<string, Array<string>>): Snapshot => ({
  rows: new Map(
    tables.map((table) => [
      table,
      db
        .query(
          `SELECT rowid AS rid, ${(columns?.get(table) ?? columnsOf(db, table)).join(", ")} FROM ${table} ORDER BY rowid`,
        )
        .all()
        .map(withoutSource),
    ]),
  ),
  fks: new Map(tables.map((table) => [table, db.query(`PRAGMA foreign_key_list(${table})`).all()])),
})

// Schema objects that migrations after 0014 add on the same open.
const LATER_MIGRATION_OBJECTS = ["run_continuations_original"]

const withoutSource = (row: unknown): unknown => {
  const { source: _source, ...rest } = row as Record<string, unknown>

  return rest
}

test("0014 upgrades a copy of a populated schema 13 database with old-label rows, preserving rows, indexes, triggers, views and FKs", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-legacy-source-upgrade-"))
  const original = join(root, "fixture.db")
  const filename = join(root, "upgraded.db")
  let db = new Database(original)
  try {
    await buildSchema13(db)
    seed(db)
    expect(() => db.exec("UPDATE bots SET source='legacy' WHERE id='b-old'")).toThrow()
    expect(
      db.query("SELECT name FROM sqlite_schema WHERE type='view' AND name='transcript_message_events'").all(),
    ).toHaveLength(1)
    const tables = (
      db
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name <> 'schema_meta' AND name <> 'settings' AND name <> 'import_records' AND name <> 'imports' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    const columns = new Map(tables.map((table) => [table, columnsOf(db, table)]))
    const before = snapshot(db, tables, columns)
    const objectsBefore = db
      .query(
        "SELECT name FROM sqlite_schema WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
    db.close()
    copyFileSync(original, filename)
    db = openDatabase({ filename })
    for (let reopen = 0; reopen < 2; reopen++) {
      const after = snapshot(db, tables, columns)
      expect(after.rows).toEqual(before.rows)
      expect(after.fks).toEqual(before.fks)
      expect(
        db
          .query(
            "SELECT name FROM sqlite_schema WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .filter((row) => !LATER_MIGRATION_OBJECTS.includes((row as { name: string }).name)),
      ).toEqual(objectsBefore)
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
      expect(db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      })
      expect(
        db
          .query(
            "SELECT 'bots' AS t, id, source FROM bots UNION ALL SELECT 'threads', id, source FROM threads UNION ALL SELECT 'messages', id, source FROM messages UNION ALL SELECT 'routines', id, source FROM routines ORDER BY 1, 2",
          )
          .all(),
      ).toEqual([
        { t: "bots", id: "b-local", source: "local" },
        { t: "bots", id: "b-old", source: "legacy" },
        { t: "messages", id: "m1", source: "local" },
        { t: "messages", id: "m2", source: "legacy" },
        { t: "messages", id: "m3", source: "legacy" },
        { t: "routines", id: "ro-local", source: "local" },
        { t: "routines", id: "ro-old", source: "legacy" },
        { t: "threads", id: "t-local", source: "local" },
        { t: "threads", id: "t-old", source: "legacy" },
      ])
      expect(db.query("SELECT source, source_kind FROM import_records ORDER BY source").all()).toEqual([
        { source: "legacy", source_kind: "bot" },
        { source: "legacy-identity-v1", source_kind: "bot" },
      ])
      expect(db.query("SELECT source FROM imports").all()).toEqual([{ source: "legacy" }])
      expect(db.query("SELECT key FROM settings WHERE key LIKE 'imports.%'").all()).toEqual([])
      for (const table of SOURCE_TABLES)
        expect(
          (db.query("SELECT sql FROM sqlite_schema WHERE name = ?").get(table) as { sql: string }).sql,
        ).not.toContain(OLD)
      db.close()
      db = openDatabase({ filename })
    }
    expect(() => db.exec(`UPDATE bots SET source='${OLD}' WHERE id='b-local'`)).toThrow()
    db.exec("UPDATE bots SET source='legacy' WHERE id='b-local'")
    expect(() => db.exec("DELETE FROM threads WHERE id='t-old'")).not.toThrow()
    const fixture = new Database(original, { readonly: true })
    expect(fixture.query("SELECT source FROM bots WHERE id='b-old'").get()).toEqual({ source: OLD })
    fixture.close()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("0014 keeps the importer working on a fresh database", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-legacy-source-fresh-"))
  const db = openDatabase({ filename: join(root, "fresh.db") })
  try {
    db.exec(
      "INSERT INTO bots(id,name,provider,home_dir,source,created_at,updated_at) VALUES ('b','Bot','codex','/bot','legacy',1,1)",
    )
    expect(db.query("SELECT source FROM bots WHERE id='b'").get()).toEqual({ source: "legacy" })
    expect(() =>
      db.exec(
        `INSERT INTO bots(id,name,provider,home_dir,source,created_at,updated_at) VALUES ('c','Bot','codex','/bot','${OLD}',1,1)`,
      ),
    ).toThrow()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
