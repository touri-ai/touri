import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("schema 32 preserves per-run routine conversations and defaults other bots to main", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-conversation-migration-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  try {
    for (let version = 1; version <= 32; version++)
      database.exec(
        await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
        ).text(),
      )
    database.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
        VALUES ('per-run','Per run','codex','/per-run',1,1), ('main','Main','codex','/main',1,1);
      INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,continuity,created_at,updated_at)
        VALUES ('routine-per-run','per-run','Per-run routine','Check','0 9 * * *','UTC','new-thread',1,1),
          ('routine-main','main','Main routine','Check','0 9 * * *','UTC','main-thread',1,1);
    `)
    database.close()
    database = openDatabase({ filename })

    expect(SCHEMA_VERSION).toBe(34)
    expect(database.query("SELECT id,automatic_conversation_mode FROM bots ORDER BY id").all()).toEqual([
      { id: "main", automatic_conversation_mode: "main" },
      { id: "per-run", automatic_conversation_mode: "task" },
    ])
    database.exec(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('new','New','codex','/new',1,1)",
    )
    expect(database.query("SELECT automatic_conversation_mode FROM bots WHERE id='new'").get()).toEqual({
      automatic_conversation_mode: "main",
    })
    expect(() => database.exec("UPDATE bots SET automatic_conversation_mode='unknown' WHERE id='new'")).toThrow()
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
