import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import continuationsSql from "../../src/kernel/migrations/0015.sql" with { type: "text" }

test("permission continuation migration preserves existing links across upgrades and reopens", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-permission-migration-"))
  const filename = join(root, "test.db")
  let db = openDatabase({ filename })
  try {
    db.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Test','codex','/tmp',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Test',1,1);
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES
        ('original','t','b','codex','user','interrupted',1),
        ('restart','t','b','codex','retry','succeeded',2),
        ('permission','t','b','codex','retry','succeeded',3);
      DROP TABLE run_continuations;
      DELETE FROM schema_meta WHERE key = 'permission_continuations_version';
    `)
    db.exec(continuationsSql)
    db.exec("INSERT INTO run_continuations VALUES ('restart','original','original','app_restart',2)")
    db.close()
    db = openDatabase({ filename })
    expect(db.query("SELECT reason FROM run_continuations").all()).toEqual([{ reason: "app_restart" }])
    db.exec("INSERT INTO run_continuations VALUES ('permission','original','restart','permission_granted',3)")
    db.close()
    db = openDatabase({ filename })
    expect(db.query("SELECT reason FROM run_continuations ORDER BY created_at").all()).toEqual([
      { reason: "app_restart" },
      { reason: "permission_granted" },
    ])
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'run_continuations_original'").get()).not.toBeNull()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("browser handback continuation reason survives database reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-continuation-migration-"))
  const filename = join(root, "test.db")
  let db = openDatabase({ filename })
  try {
    db.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Test','codex','/tmp',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Test',1,1);
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES
        ('original','t','b','codex','user','succeeded',1),
        ('resumed','t','b','codex','retry','succeeded',2);
      INSERT INTO browser_takeover_continuations VALUES ('resumed','original','original',3);
    `)
    db.close()
    db = openDatabase({ filename })

    expect(
      db.query("SELECT run_id, original_run_id, previous_run_id FROM browser_takeover_continuations").all(),
    ).toEqual([{ run_id: "resumed", original_run_id: "original", previous_run_id: "original" }])
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
