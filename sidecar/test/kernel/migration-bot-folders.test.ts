import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("schema 15 upgrades grants off by default and preserves them across reopens", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-folder-migration-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  try {
    for (let version = 1; version <= 15; version++)
      database.exec(
        await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
        ).text(),
      )
    database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Keep','codex','/bot',1,1);
      INSERT INTO bot_machines(bot_id,vm_id,volume) VALUES ('bot','machine','workspace');`)
    database.close()
    database = openDatabase({ filename })
    expect(SCHEMA_VERSION).toBe(34)
    expect(database.query("SELECT name,folders_json,any_folder_access FROM bots").get()).toEqual({
      name: "Keep",
      folders_json: "[]",
      any_folder_access: 0,
    })
    expect(database.query("SELECT volume,folder_fingerprint FROM bot_machines").get()).toEqual({
      volume: "workspace",
      folder_fingerprint: "",
    })
    const folders = JSON.stringify([{ path: "/selected", access: "read-only" }])
    database.query("UPDATE bots SET folders_json=?,any_folder_access=1").run(folders)
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT folders_json,any_folder_access FROM bots").get()).toEqual({
      folders_json: folders,
      any_folder_access: 1,
    })
    expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    })
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
