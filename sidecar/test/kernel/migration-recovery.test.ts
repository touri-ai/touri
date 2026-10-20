import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import { historyMigrationStatus } from "../../src/kernel/history-backfill"

test("schema 9 preserves all legacy tool dispositions through recovery migration and reopens", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-recovery-migration-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  try {
    database.exec("PRAGMA foreign_keys = ON")
    for (let n = 1; n <= 9; n++)
      database.exec(
        await Bun.file(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`)).text(),
      )
    database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','running',1);`)
    for (const resolution of ["running", "succeeded", "failed", "canceled", "interrupted", "unknown"])
      database
        .query("INSERT INTO tool_resolutions VALUES ('r',?,'t',?,?,?)")
        .run(resolution, JSON.stringify({ result: resolution }), resolution, resolution === "running" ? null : 42)
    const before = database.query("SELECT * FROM tool_resolutions ORDER BY call_id").all()
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT * FROM tool_resolutions ORDER BY call_id").all()).toEqual(before)
    for (const resolution of ["cancelled_by_user", "interrupted_by_restart", "completed_unobserved"])
      database.query("INSERT INTO tool_resolutions VALUES ('r',?,'t','{}',?,42)").run(resolution, resolution)
    database.close()
    database = openDatabase({ filename })
    expect(database.query("SELECT COUNT(*) AS n FROM tool_resolutions").get()).toEqual({ n: 9 })
    expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    })
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("schema 9 upgrades 50k messages to the final schema without rewriting history and reopens idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-schema9-50k-"))
  const filename = join(root, "touri.db")
  let database = new Database(filename)
  const fingerprint = (table: string, order: string, columns: string) =>
    createHash("sha256")
      .update(JSON.stringify(database.query(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all()))
      .digest("hex")
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL")
    for (let n = 1; n <= 9; n++)
      database.exec(
        await Bun.file(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`)).text(),
      )
    database.exec(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1)",
    )
    const timestamp = Date.now()
    const insert =
      database.query(`INSERT INTO messages(id,thread_id,parent_id,role,kind,text,parts_json,created_at,updated_at)
      VALUES (?, ?, ?, 'assistant','text', ?, ?, ?, ?)`)
    database.transaction(() => {
      for (let thread = 0; thread < 5; thread++) {
        const threadId = `t${thread}`
        database
          .query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?, 'b','Histórico',?,?)")
          .run(threadId, timestamp, timestamp)
        for (let row = 0; row < 10_000; row++) {
          const text = `Mensagem preservada ${thread}/${row}`
          insert.run(
            `m${row}`,
            threadId,
            row ? `m${row - 1}` : null,
            text,
            JSON.stringify([{ type: "text", text }]),
            timestamp + row,
            timestamp + row,
          )
        }
        database.query("UPDATE threads SET active_leaf_id = 'm9999' WHERE id = ?").run(threadId)
      }
    })()
    expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: "9" })
    const columns = (table: string) =>
      (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => name)
        .join(", ")
    const messageColumns = columns("messages")
    const transcriptColumns = columns("transcript_entries")
    const threadColumns = columns("threads")
    const before = [
      fingerprint("messages", "thread_id, seq", messageColumns),
      fingerprint("transcript_entries", "id", transcriptColumns),
      fingerprint("threads", "id", threadColumns),
    ]
    database.close()
    for (let reopen = 0; reopen < 2; reopen++) {
      database = openDatabase({ filename })
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      })
      expect(database.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 50_000 })
      expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 50_000 })
      expect([
        fingerprint("messages", "thread_id, seq", messageColumns),
        fingerprint("transcript_entries", "id", transcriptColumns),
        fingerprint("threads", "id", threadColumns),
      ]).toEqual(before)
      expect(historyMigrationStatus(database)).toEqual({ running: false, done: 0, total: 0 })
      expect(database.query("SELECT COUNT(*) AS n FROM rejections").get()).toEqual({ n: 0 })
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      database.close()
    }
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

for (const version of [9, 10]) {
  test(`schema ${version} upgrades to 12 with recovery and problem reports, preserving data on reopen`, async () => {
    const root = mkdtempSync(join(tmpdir(), `touri-schema${version}-reports-`))
    const filename = join(root, "touri.db")
    let database = new Database(filename)
    try {
      database.exec("PRAGMA foreign_keys = ON")
      // Version 10 is the recovery-only schema, before problem reports existed.
      for (let n = 1; n <= version; n++)
        database.exec(
          await Bun.file(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`)).text(),
        )
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(version),
      })
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'problem_reports'").get()).toBeNull()
      database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
        INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);
        INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','running',1);
        INSERT INTO tool_resolutions VALUES ('r','call','t','{"result":"preserved"}','succeeded',42);`)
      if (version === 10) database.exec("INSERT INTO rejections VALUES ('t',1,0,'{}',42)")
      const resolutions = database.query("SELECT * FROM tool_resolutions").all()
      database.close()
      database = openDatabase({ filename })
      expect(SCHEMA_VERSION).toBe(34)
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      })
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'transcript_recovery_version'").get()).toEqual({
        value: "1",
      })
      expect(database.query("SELECT * FROM tool_resolutions").all()).toEqual(resolutions)
      expect(database.query("SELECT COUNT(*) AS n FROM rejections").get()).toEqual({ n: version === 10 ? 1 : 0 })
      database.exec("INSERT INTO problem_reports VALUES ('report',42,'Relato','zip')")
      database.exec("INSERT INTO tool_resolutions VALUES ('r','restart','t','{}','interrupted_by_restart',43)")
      const rejections = database.query("SELECT * FROM rejections").all()
      const reports = database.query("SELECT * FROM problem_reports").all()
      const recovered = database.query("SELECT * FROM tool_resolutions ORDER BY call_id").all()
      database.close()
      database = openDatabase({ filename })
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
        value: String(SCHEMA_VERSION),
      })
      expect(database.query("SELECT * FROM rejections").all()).toEqual(rejections)
      expect(database.query("SELECT * FROM problem_reports").all()).toEqual(reports)
      expect(database.query("SELECT * FROM tool_resolutions ORDER BY call_id").all()).toEqual(recovered)
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
