import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("schema 18 keeps existing host bots on touri and VM bots on the machine browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-migration-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  try {
    for (let version = 1; version <= 18; version++)
      database.exec(
        await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
        ).text(),
      )
    database.exec("UPDATE schema_meta SET value='18' WHERE key='schema_version'")
    database.exec(
      "INSERT INTO bots(id,name,provider,home_dir,machine,created_at,updated_at) VALUES ('host','Host','codex','/host','local',1,1), ('guest','Guest','codex','/guest','vm',1,1)",
    )
    database.close()
    database = openDatabase({ filename })
    expect(SCHEMA_VERSION).toBe(30)
    expect(database.query("SELECT id,browser FROM bots ORDER BY id").all()).toEqual([
      { id: "guest", browser: "machine" },
      { id: "host", browser: "touri" },
    ])
    database.exec(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('new','New','codex','/new',1,1)",
    )
    expect(database.query("SELECT browser FROM bots WHERE id='new'").get()).toEqual({ browser: "touri" })
    expect(() => database.exec("UPDATE bots SET browser='firefox' WHERE id='host'")).toThrow()
    database.exec("UPDATE bots SET browser='local' WHERE id='host'")
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT browser FROM bots WHERE id='host'").get()).toEqual({ browser: "local" })
    expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    })
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
