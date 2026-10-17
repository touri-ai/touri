import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("the contract schema matches runtime migrations through its declared snapshot version", () => {
  const contract = new Database(":memory:")
  const migrated = new Database(":memory:")
  try {
    contract.exec(readFileSync(join(import.meta.dir, "../../../packages/contracts/schema.sql"), "utf8"))
    const version = Number(
      (contract.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value,
    )
    expect(Number.isInteger(version) && version > 0).toBe(true)
    for (let n = 1; n <= version; n++)
      migrated.exec(
        readFileSync(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`), "utf8"),
      )
    expect(migrated.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(version),
    })
    const tables = contract.query("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
      name: string
    }[]
    for (const { name } of tables) {
      const table = JSON.stringify(name)
      // Column order may differ when the snapshot folds ALTERs into CREATEs.
      const columns = (db: Database) =>
        (db.query(`PRAGMA table_info(${table})`).all() as Array<{ cid: number; name: string }>)
          .map(({ cid: _cid, ...column }) => column)
          .sort((a, b) => a.name.localeCompare(b.name))
      expect(columns(migrated)).toEqual(columns(contract))
      expect(migrated.query(`PRAGMA foreign_key_list(${table})`).all()).toEqual(
        contract.query(`PRAGMA foreign_key_list(${table})`).all(),
      )
    }
    const indexes = (db: Database) =>
      db.query("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL").all()
    for (const index of indexes(contract) as Array<{ name: string; tbl_name: string; sql: string }>) {
      const actual = (indexes(migrated) as (typeof index)[]).find((entry) => entry.name === index.name)
      expect(actual?.tbl_name).toBe(index.tbl_name)
      const normalize = (sql: string) => sql.replaceAll(" IF NOT EXISTS", "").replaceAll(/\s+/g, " ").trim()
      expect(normalize(actual?.sql ?? "")).toBe(normalize(index.sql))
    }
    for (const db of [contract, migrated]) {
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    }
  } finally {
    contract.close()
    migrated.close()
  }
})
