import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { collectUnusedOutputBlobs } from "../../src/kernel/data-maintenance"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { atomicWriteFile } from "../../src/kernel/files"
import { OUTPUT_BLOB_ORIGIN } from "../../src/kernel/output-blobs"
import { createStorageUpgrade, maintainDatabasePages } from "../../src/kernel/storage-upgrade"

const legacy = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-storage-upgrade-"))
  const filename = join(root, "touri.db")
  const database = new Database(filename)
  for (let n = 1; n <= 20; n++)
    database.exec(
      readFileSync(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`), "utf8"),
    )
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('b','Teste','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Histórico',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    VALUES ('m','t','assistant','text','streaming','Texto preservado','[]',1,1);`)
  database.transaction(() => {
    for (let n = 0; n < 90; n++)
      database.query("UPDATE messages SET parts_json = ? WHERE id = 'm'").run(
        JSON.stringify([
          {
            type: "command",
            callId: `c${n}`,
            command: "printf exemplo",
            cwd: "/tmp",
            exitCode: 0,
            outputTail: String(n).padEnd(32_000, "x"),
          },
        ]),
      )
  })()
  database.close()
  return { root, filename }
}

test("existing history is backed up before resumable pruning; unpublished output and conversation survive", async () => {
  const f = legacy()
  let database = openDatabase({ filename: f.filename })
  let upgrade = createStorageUpgrade({ database, appData: f.root })
  try {
    const outputPath = join(f.root, "attachments", "backed-up-output.txt")
    atomicWriteFile({ root: f.root, path: outputPath, content: "Saída completa preservada" })
    database
      .query(
        "INSERT INTO attachments(id,path,mime,bytes,origin_path,created_at) VALUES ('backup-output',?,'text/plain',32,?,1)",
      )
      .run(outputPath, OUTPUT_BLOB_ORIGIN)
    const original = database.query("SELECT text,parts_json FROM messages WHERE id = 'm'").get()
    const count = () => (database.query("SELECT COUNT(*) AS n FROM transcript_entries").get() as { n: number }).n
    // Until the publisher captures the old tail, pruning may not touch it.
    expect(await upgrade.step()).toBe(true)
    expect(count()).toBe(91)
    const backupPath = join(f.root, "backups", "history-before-22.db")
    const backup = new Database(backupPath, { readonly: true })
    try {
      expect(backup.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
      expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(backup.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 91 })
      expect(backup.query("SELECT text,parts_json FROM messages WHERE id = 'm'").get()).toEqual(original)
      expect(backup.query("SELECT path,bytes,origin_path FROM attachments WHERE id = 'backup-output'").get()).toEqual({
        path: outputPath,
        bytes: 32,
        origin_path: OUTPUT_BLOB_ORIGIN,
      })
    } finally {
      backup.close()
    }
    if (process.platform !== "win32") expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    const backupModified = statSync(backupPath).mtimeMs
    const bus = createEventBus(database)
    bus.stop()
    expect(await upgrade.step()).toBe(true)
    const cursor = upgrade.snapshot()?.processed ?? 0
    expect(cursor).toBeGreaterThan(0)
    expect(cursor).toBeLessThan(91)
    upgrade.dispose()
    database.close()
    database = openDatabase({ filename: f.filename })
    upgrade = createStorageUpgrade({ database, appData: f.root })
    expect(upgrade.snapshot()?.processed).toBe(cursor)
    while (await upgrade.step()) {
      /* Resume the committed cursor. */
    }
    expect(count()).toBe(0)
    expect(statSync(backupPath).mtimeMs).toBe(backupModified)
    expect(database.query("SELECT text,parts_json FROM messages WHERE id = 'm'").get()).toEqual(original)
    expect(database.query("SELECT through_seq FROM transcript_retention WHERE thread_id = 't'").get()).toEqual({
      through_seq: 91,
    })
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(upgrade.snapshot()).toBeNull()
    // Even an output referenced only by the backup remains restorable after GC.
    expect(await collectUnusedOutputBlobs(database, f.root, Date.now(), null)).toBe(0)
    expect(existsSync(outputPath)).toBe(true)
  } finally {
    upgrade.dispose()
    database.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "online backup canonicalizes external directory aliases and preserves committed WAL data",
  async () => {
    const f = legacy()
    const aliasRoot = mkdtempSync(join(tmpdir(), "touri-backup-alias-"))
    const alias = join(aliasRoot, "parent")
    symlinkSync(dirname(f.root), alias, "dir")
    const appData = join(alias, basename(f.root))
    const database = openDatabase({ filename: join(appData, "touri.db") })
    const upgrade = createStorageUpgrade({ database, appData, backupMethod: "online" })
    try {
      database.exec("PRAGMA wal_autocheckpoint = 0")
      database.exec("UPDATE messages SET text = 'Texto confirmado no WAL' WHERE id = 'm'")
      const outputPath = join(f.root, "attachments", "wal-output.txt")
      atomicWriteFile({ root: f.root, path: outputPath, content: "Saída confirmada no WAL" })
      database
        .query(
          "INSERT INTO attachments(id,path,mime,bytes,origin_path,created_at) VALUES ('wal-output',?,'text/plain',32,?,1)",
        )
        .run(outputPath, OUTPUT_BLOB_ORIGIN)
      const attachment = database.query("SELECT * FROM attachments WHERE id = 'wal-output'").get()
      const original = database.query("SELECT text,parts_json,updated_seq FROM messages WHERE id = 'm'").get()
      expect(statSync(`${f.filename}-wal`).size).toBeGreaterThan(0)
      expect(await upgrade.step()).toBe(true)
      const backupPath = join(f.root, "backups", "history-before-22.db")
      const backup = new Database(backupPath, { readonly: true })
      try {
        expect(backup.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
        expect(backup.query("SELECT text,parts_json,updated_seq FROM messages WHERE id = 'm'").get()).toEqual(original)
        expect(backup.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 92 })
        expect(backup.query("SELECT * FROM attachments WHERE id = 'wal-output'").get()).toEqual(attachment)
        expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      } finally {
        backup.close()
      }
      expect(database.query("SELECT text,parts_json,updated_seq FROM messages WHERE id = 'm'").get()).toEqual(original)
      expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 92 })
      expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
      expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    } finally {
      upgrade.dispose()
      database.close()
      rmSync(aliasRoot, { recursive: true, force: true })
      rmSync(f.root, { recursive: true, force: true })
    }
  },
)

test("missing or malformed progress never bypasses the backup of an existing store", () => {
  const f = legacy()
  const database = openDatabase({ filename: f.filename })
  try {
    for (const value of ["{", '{"cursor":-1,"total":91,"backup":true}', null]) {
      if (value === null) database.exec("DELETE FROM settings WHERE key = 'storage.upgrade.22'")
      else database.query("UPDATE settings SET value_json = ? WHERE key = 'storage.upgrade.22'").run(value)
      const upgrade = createStorageUpgrade({ database, appData: f.root })
      expect(upgrade.snapshot()).toEqual({ running: true, processed: 0, total: 91 })
      upgrade.dispose()
    }
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 91 })
  } finally {
    database.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("a failed private backup leaves every old revision untouched", async () => {
  const f = legacy()
  const outside = mkdtempSync(join(tmpdir(), "touri-backup-outside-"))
  const database = openDatabase({ filename: f.filename })
  const bus = createEventBus(database)
  bus.stop()
  const upgrade = createStorageUpgrade({ database, appData: f.root })
  try {
    symlinkSync(outside, join(f.root, "backups"))
    await expect(upgrade.step()).rejects.toThrow()
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 91 })
    expect(upgrade.snapshot()?.processed).toBe(0)
    expect(database.query("SELECT value FROM schema_meta WHERE key = 'storage_upgrade_22'").get()).toEqual({
      value: "pending",
    })
  } finally {
    upgrade.dispose()
    database.close()
    rmSync(f.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("new stores reclaim a bounded number of free pages and retain a live reader", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-storage-pages-"))
  const filename = join(root, "touri.db")
  const database = openDatabase({ filename })
  const reader = new Database(filename, { readonly: true })
  try {
    expect(database.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
    database.exec("CREATE TABLE discarded(body BLOB)")
    database.transaction(() => {
      for (let n = 0; n < 400; n++) database.exec("INSERT INTO discarded VALUES (zeroblob(4096))")
    })()
    reader.exec("BEGIN")
    expect(reader.query("SELECT COUNT(*) AS n FROM discarded").get()).toEqual({ n: 400 })
    database.exec("DELETE FROM discarded")
    const free = () => (database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
    const before = free()
    maintainDatabasePages(database)
    expect(free()).toBeLessThan(before)
    expect(before - free()).toBeLessThanOrEqual(32)
    expect(reader.query("SELECT COUNT(*) AS n FROM discarded").get()).toEqual({ n: 400 })
    reader.exec("COMMIT")
    expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
  } finally {
    reader.close()
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
