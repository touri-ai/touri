import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("schema 16 upgrades bots to the host login with connectors off and preserves choices across reopens", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-profile-migration-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  try {
    for (let version = 1; version <= 16; version++)
      database.exec(
        await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
        ).text(),
      )
    database.exec(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Keep','claude','/bot',1,1)",
    )
    database.close()
    database = openDatabase({ filename })
    expect(SCHEMA_VERSION).toBe(29)
    expect(database.query("SELECT name,provider_profile,claude_ai_connectors FROM bots").get()).toEqual({
      name: "Keep",
      provider_profile: null,
      claude_ai_connectors: 0,
    })
    expect(() => database.exec("UPDATE bots SET claude_ai_connectors=2")).toThrow()
    database.query("UPDATE bots SET provider_profile='clav',claude_ai_connectors=1").run()
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT provider_profile,claude_ai_connectors FROM bots").get()).toEqual({
      provider_profile: "clav",
      claude_ai_connectors: 1,
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
