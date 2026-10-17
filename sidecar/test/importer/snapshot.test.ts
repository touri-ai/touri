import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_SNAPSHOT_BYTES, openLegacySnapshot } from "../../src/importer/legacy/snapshot"

test("A04 oversized snapshots are rejected before SQLite opens them", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-snapshot-size-"))
  const path = join(root, "source.db")
  try {
    writeFileSync(path, "")
    truncateSync(path, MAX_SNAPSHOT_BYTES + 1)
    expect(() => openLegacySnapshot(path)).toThrow(/bounded regular/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("A04 source authorizer denies ATTACH, VACUUM INTO, writes and hostile views", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-snapshot-"))
  const path = join(root, "source.db")
  const db = new Database(path)
  db.exec(
    "CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('ordinary'), (''); CREATE TABLE thread_state(thread_id TEXT,active_leaf_id TEXT)",
  )
  db.close()
  try {
    const snapshot = openLegacySnapshot(path)
    try {
      expect(snapshot.query("SELECT text FROM messages").all()).toEqual([{ text: "ordinary" }, { text: "" }])
      for (const sql of [
        `ATTACH '${join(root, "attached.db")}' AS other`,
        `VACUUM INTO '${join(root, "vacuum.db")}'`,
        "INSERT INTO messages VALUES ('attack')",
        "UPDATE messages SET text='attack'",
        "DELETE FROM messages",
        "PRAGMA writable_schema=ON",
        "SELECT load_extension('attack')",
      ])
        expect(() => snapshot.query(sql).all()).toThrow()
      expect(existsSync(join(root, "attached.db"))).toBe(false)
      expect(existsSync(join(root, "vacuum.db"))).toBe(false)
    } finally {
      snapshot.close()
    }
    const writer = new Database(path)
    writer.exec("ALTER TABLE messages RENAME TO private_data; CREATE VIEW messages AS SELECT * FROM private_data")
    writer.close()
    const hostile = openLegacySnapshot(path)
    try {
      expect(() => hostile.query("SELECT text FROM messages").all()).toThrow()
    } finally {
      hostile.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
