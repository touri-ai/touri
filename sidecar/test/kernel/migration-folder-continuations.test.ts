import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

test("schema 17 preserves continuation history and accepts folder access continuations across reopens", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-folder-continuations-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  try {
    for (let version = 1; version <= 17; version++)
      database.exec(
        await Bun.file(
          join(import.meta.dir, `../../src/kernel/migrations/${String(version).padStart(4, "0")}.sql`),
        ).text(),
      )
    database.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Keep','codex','/bot',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Keep',1,1);
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES
        ('old','thread','bot','codex','retry','succeeded',1),
        ('next','thread','bot','codex','retry','succeeded',2);
      INSERT INTO run_continuations VALUES ('old','original','previous','provider_crash',1);
    `)
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT * FROM run_continuations").all()).toEqual([
      {
        run_id: "old",
        original_run_id: "original",
        previous_run_id: "previous",
        reason: "provider_crash",
        created_at: 1,
      },
    ])
    database.exec("INSERT INTO run_continuations VALUES ('next','original','old','permission_granted',2)")
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT reason FROM run_continuations ORDER BY created_at").all()).toEqual([
      { reason: "provider_crash" },
      { reason: "permission_granted" },
    ])
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    database.exec("DELETE FROM runs WHERE id='next'")
    expect(database.query("SELECT COUNT(*) AS n FROM run_continuations").get()).toEqual({ n: 1 })
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
