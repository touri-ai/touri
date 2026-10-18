import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const databases = new Set<Database>()
const roots = new Set<string>()
afterEach(() => {
  databases.forEach((database) => {
    database.close()
  })
  roots.forEach((root) => {
    rmSync(root, { recursive: true, force: true })
  })
  databases.clear()
  roots.clear()
})

const openFixture = (filename: string) => {
  const database = openDatabase({ filename })
  databases.add(database)
  return database
}

const closeFixture = (database: Database) => {
  database.close()
  databases.delete(database)
}

test("schema 24 gains persistent goals without changing conversation or run records", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-goals-migration-"))
  roots.add(root)
  const filename = join(root, "touri.db")
  const previous = openFixture(filename)
  previous.exec(`
    DROP TABLE goals;
    UPDATE schema_meta SET value='24' WHERE key='schema_version';
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Demo','codex','/tmp/demo',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Demo',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','running',1);
  `)
  const runs = previous.query("SELECT * FROM runs").all()
  closeFixture(previous)

  const upgraded = openFixture(filename)
  const checkpoint = JSON.stringify({
    text: "Comparar opções",
    completionCriterion: "Tabela revisada",
    turnsUsed: 1,
    maxTurns: 3,
  })
  upgraded.query("INSERT INTO goals(thread_id,run_id,checkpoint_json) VALUES ('t','r',?)").run(checkpoint)
  closeFixture(upgraded)
  const reopened = openFixture(filename)

  expect(reopened.query("SELECT checkpoint_json FROM goals WHERE thread_id='t'").get()).toEqual({
    checkpoint_json: checkpoint,
  })
  expect(reopened.query("SELECT * FROM runs").all()).toEqual(runs)
  expect(reopened.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "25" })
  expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([])
})
