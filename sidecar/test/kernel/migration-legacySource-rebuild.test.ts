import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEPRECATED_IMPORT_ALIAS } from "../../src/importer/deprecatedAliases"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import { legacySourceRebuild } from "../../src/kernel/legacySourceRebuild"
import { assertLiveTranscriptReferences, REPLACED_TRANSCRIPT_TRIGGERS } from "./migration-transcript-fixture"

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
const foreignKeys = (db: Database, table: string) =>
  (db.query(`PRAGMA foreign_key_list(${quote(table)})`).all() as Array<{ id: number }>).map(({ id: _id, ...fk }) => fk)
const schemaObjects = (db: Database) =>
  (
    db
      .query(
        "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name",
      )
      .all() as Array<{ type: string; name: string; sql: string }>
  ).map((object) => ({ ...object, sql: object.sql.replace(/\s+/g, " ") }))

for (let version = 1; version < SCHEMA_VERSION; version++) {
  test(`legacy source upgrade from populated schema ${version} preserves historical rows and working schema dependencies`, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-source-dependencies-"))
    const filename = join(root, "touri.db")
    let db = new Database(filename)
    try {
      db.exec("PRAGMA foreign_keys = ON")
      const source = version < 14 ? DEPRECATED_IMPORT_ALIAS : "legacy"
      for (let migration = 1; migration <= version; migration++) {
        let sql = await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(migration).padStart(4, "0")}.sql`),
        ).text()
        if (version < 14) sql = sql.replaceAll("'legacy'", `'${source}'`)
        if (migration === 12) db.exec("PRAGMA foreign_keys = OFF")
        // Schema 33 adds these columns in db.ts before applying its SQL dependencies.
        if (migration === 33)
          db.exec(`
            ALTER TABLE bots ADD COLUMN responsible_person_id TEXT;
            ALTER TABLE threads ADD COLUMN owner_person_id TEXT;
            ALTER TABLE attachments ADD COLUMN owner_person_id TEXT;
          `)
        db.exec(sql)
        if (migration === 12) db.exec("PRAGMA foreign_keys = ON")
      }
      db.exec(`
        INSERT INTO bots(id,name,provider,home_dir,source,created_at,updated_at)
          VALUES ('b','Imported','codex','/fixture','${source}',1,2);
        INSERT INTO threads(id,bot_id,title,source,created_at,updated_at)
          VALUES ('t','b','History','${source}',1,2);
        INSERT INTO provider_sessions(id,thread_id,provider,external_session_id,fingerprint,state,created_at,last_used_at)
          VALUES ('session','t','codex','native-session','fingerprint','active',1,2);
        INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
          VALUES ('r','t','b','codex','user','queued',1);
        INSERT INTO messages(id,thread_id,role,kind,text,source,created_at,updated_at)
          VALUES ('m','t','user','text','Preserved history','${source}',1,2);
        INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,source,created_at,updated_at)
          VALUES ('routine','b','Daily','prompt','0 9 * * *','UTC','${source}',1,2);
        INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
          VALUES ('b-local','Local','claude','/fixture-local',1,2);
        INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t-local','b-local','Local',1,2);
        INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at)
          VALUES ('m-local','t-local','user','text','Local history',1,2);
        INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at)
          VALUES ('routine-local','b-local','Weekly','prompt','0 9 * * 1','UTC',1,2);
        INSERT INTO imports(id,source,origin,status,started_at) VALUES ('import','${source}','/fixture','succeeded',1);
        INSERT INTO import_records(source,source_kind,source_id,local_id,content_hash,import_id,imported_at)
          VALUES ('${source}','bot','original-bot','b','hash','import',1);
        INSERT INTO settings(key,value_json,updated_at) VALUES ('fixture','0',1);
        CREATE INDEX fixture_threads_title ON threads(title);
        CREATE VIEW fixture_threads AS SELECT id, title FROM threads;
        CREATE VIEW fixture_indirect AS SELECT * FROM fixture_threads;
        CREATE TRIGGER "fixture view trigger" INSTEAD OF UPDATE OF title ON fixture_indirect
          BEGIN UPDATE threads SET title = NEW.title WHERE id = NEW.id; END;
        CREATE TRIGGER "fixture""cross trigger" AFTER UPDATE OF name ON routines
          BEGIN UPDATE threads SET title = NEW.name WHERE id IN (SELECT id FROM fixture_indirect); END;
        CREATE TRIGGER fixture_unrelated AFTER UPDATE OF value_json ON settings
          WHEN NEW.key = 'fixture' BEGIN UPDATE bots SET name = 'Renamed' WHERE id = 'b'; END;
      `)
      const tables = (
        db
          .query(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT IN ('schema_meta','settings') ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name)
      // Compare every original column, including rowids. Later migrations may add
      // columns, but must preserve all existing values except the importer label.
      const before = tables.map((table) => {
        const columns = (db.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(
          ({ name }) => quote(name),
        )
        const select = `SELECT rowid, ${columns.join(", ")} FROM ${quote(table)} ORDER BY rowid`
        return {
          select,
          rows: (db.query(select).all() as Array<Record<string, unknown>>).map((row) =>
            row.source === DEPRECATED_IMPORT_ALIAS ? { ...row, source: "legacy" } : row,
          ),
          table,
          fks: foreignKeys(db, table),
        }
      })
      const objects = schemaObjects(db)
      db.close()

      for (let reopen = 0; reopen < 2; reopen++) {
        db = openDatabase({ filename })
        for (const { select, rows, table, fks } of before) {
          expect(db.query(select).all()).toEqual(rows)
          const afterFks = foreignKeys(db, table)
          for (const fk of fks) expect(afterFks).toContainEqual(fk)
        }
        const after = schemaObjects(db)
        for (const object of objects) {
          // 0022 intentionally replaces the two native message capture triggers.
          // Their reference/hydration behavior is exercised below; custom schema
          // dependencies must retain their complete original definitions.
          if (REPLACED_TRANSCRIPT_TRIGGERS.has(object.name))
            expect(after.some((current) => current.name === object.name && current.type === "trigger")).toBe(true)
          else expect(after).toContainEqual(object)
        }
        for (const table of ["bots", "threads", "messages", "routines"])
          expect(db.query(`SELECT source FROM ${quote(table)} ORDER BY rowid`).all()).toEqual([
            { source: "legacy" },
            { source: "local" },
          ])
        expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
        expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
        expect(db.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
          value: String(SCHEMA_VERSION),
        })
        expect(() => db.exec(`UPDATE threads SET source = '${DEPRECATED_IMPORT_ALIAS}'`)).toThrow()
        db.close()
      }

      db = openDatabase({ filename })
      db.exec("UPDATE routines SET name = 'From routine'")
      expect(db.query("SELECT title FROM threads WHERE id = 't'").get()).toEqual({ title: "From routine" })
      db.exec("UPDATE fixture_indirect SET title = 'From view' WHERE id = 't'")
      expect(db.query("SELECT title FROM threads WHERE id = 't'").get()).toEqual({ title: "From view" })
      db.exec("UPDATE settings SET value_json = '1' WHERE key = 'fixture'")
      expect(db.query("SELECT name FROM bots WHERE id = 'b'").get()).toEqual({ name: "Renamed" })
      const { generation, updated_seq } = db
        .query("SELECT generation, updated_seq FROM threads WHERE id = 't'")
        .get() as {
        generation: number
        updated_seq: number
      }
      db.exec("UPDATE runs SET status = 'starting' WHERE id = 'r'")
      expect(db.query("SELECT generation FROM threads WHERE id = 't'").get()).toEqual({ generation: generation + 1 })
      assertLiveTranscriptReferences(db, "t", "live", updated_seq)
      expect(() => db.exec("INSERT INTO threads SELECT * FROM threads WHERE id = 't'")).toThrow()
      expect(() => db.exec("UPDATE threads SET bot_id = 'missing'")).toThrow()
      db.exec("UPDATE bots SET provider = 'opencode' WHERE id = 'b'")
      db.exec("UPDATE provider_sessions SET provider = 'opencode' WHERE id = 'session'")
      expect(db.query("SELECT provider FROM provider_sessions WHERE id = 'session'").get()).toEqual({
        provider: "opencode",
      })
      expect(() =>
        db.exec(`INSERT INTO provider_sessions(id,thread_id,provider,external_session_id,fingerprint,state,created_at,last_used_at)
          VALUES ('duplicate','t','opencode','duplicate-session','fingerprint','active',1,2)`),
      ).toThrow()
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("legacy source rebuild preserves native cross-table transcript triggers without replaying history", async () => {
  const db = new Database(":memory:")
  try {
    for (let migration = 1; migration <= 13; migration++) {
      const sql = await Bun.file(
        join(import.meta.dir, `../../src/kernel/migrations/${String(migration).padStart(4, "0")}.sql`),
      ).text()
      db.exec(sql.replaceAll("'legacy'", `'${DEPRECATED_IMPORT_ALIAS}'`))
    }
    db.exec(`
      INSERT INTO bots(id,name,provider,home_dir,source,created_at,updated_at)
        VALUES ('b','Imported','codex','/fixture','${DEPRECATED_IMPORT_ALIAS}',1,2);
      INSERT INTO threads(id,bot_id,title,source,created_at,updated_at) VALUES ('t','b','History','${DEPRECATED_IMPORT_ALIAS}',1,2);
      INSERT INTO messages(id,thread_id,role,kind,text,source,created_at,updated_at)
        VALUES ('m','t','user','text','History','${DEPRECATED_IMPORT_ALIAS}',1,2);
    `)
    const history = db.query("SELECT * FROM transcript_entries").all()
    expect(history).toHaveLength(1)
    const objects = schemaObjects(db)
    db.exec("PRAGMA foreign_keys = OFF")
    db.transaction(() => {
      expect(legacySourceRebuild({ database: db })).toEqual({
        success: true,
        rebuilt: ["bots", "threads", "messages", "routines"],
      })
    })()
    db.exec("PRAGMA foreign_keys = ON")
    expect(db.query("SELECT * FROM transcript_entries").all()).toEqual(history)
    expect(schemaObjects(db)).toEqual(objects)
    db.exec("UPDATE messages SET text = 'Edited after upgrade' WHERE id = 'm'")
    expect(db.query("SELECT updated_seq FROM threads").get()).toEqual({ updated_seq: 2 })
    expect(db.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 2 })
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    db.close()
  }
})

test("a failed legacy source rebuild rolls back suspended triggers, views and table data", () => {
  const db = new Database(":memory:")
  try {
    db.exec(`
      CREATE TABLE bots(id TEXT PRIMARY KEY, source TEXT CHECK (source IN ('local','${DEPRECATED_IMPORT_ALIAS}')));
      INSERT INTO bots VALUES ('b','${DEPRECATED_IMPORT_ALIAS}');
      CREATE VIEW fixture_bots AS SELECT * FROM bots;
      CREATE TRIGGER fixture_update INSTEAD OF UPDATE ON fixture_bots
        BEGIN UPDATE bots SET source = NEW.source WHERE id = NEW.id; END;
      CREATE TABLE bots_legacy_source(id TEXT);
    `)
    const objects = schemaObjects(db)
    expect(() =>
      db.transaction(() => {
        const result = legacySourceRebuild({ database: db })
        if (!result.success) throw new Error(result.error)
      })(),
    ).toThrow("already exists")
    expect(schemaObjects(db)).toEqual(objects)
    expect(db.query("SELECT * FROM fixture_bots").all()).toEqual([{ id: "b", source: DEPRECATED_IMPORT_ALIAS }])
    db.exec("UPDATE fixture_bots SET source = 'local' WHERE id = 'b'")
    expect(db.query("SELECT source FROM bots").get()).toEqual({ source: "local" })
  } finally {
    db.close()
  }
})
