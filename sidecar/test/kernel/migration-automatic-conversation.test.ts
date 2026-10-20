import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

describe("automatic conversation migration", () => {
  let root: string
  let database: Database

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "touri-conversation-migration-"))
    database = new Database(join(root, "touri.db"))
    for (let version = 1; version <= 32; version++)
      database.exec(
        await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
        ).text(),
      )
  })

  afterEach(() => {
    database.close()
    rmSync(root, { recursive: true, force: true })
  })

  test.each([32, 33])("schema %i preserves per-run conversations and defaults other bots to main", async (version) => {
    if (version === 33) {
      database.exec(`
        ALTER TABLE bots ADD COLUMN responsible_person_id TEXT;
        ALTER TABLE threads ADD COLUMN owner_person_id TEXT;
        ALTER TABLE attachments ADD COLUMN owner_person_id TEXT;
      `)
      database.exec(await Bun.file(join(import.meta.dir, "../../src/kernel/migrations/0033.sql")).text())
      database.exec("UPDATE schema_meta SET value = '33' WHERE key = 'schema_version'")
    }
    database.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
        VALUES ('per-run','Per run','codex','/per-run',1,1), ('main','Main','codex','/main',1,1);
      INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,continuity,created_at,updated_at)
        VALUES ('routine-per-run','per-run','Per-run routine','Check','0 9 * * *','UTC','new-thread',1,1),
          ('routine-main','main','Main routine','Check','0 9 * * *','UTC','main-thread',1,1);
    `)
    database.close()

    database = openDatabase({ filename: join(root, "touri.db") })

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
  })
})
