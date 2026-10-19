import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true })
  })
})

test("the store uses WAL with synchronous=NORMAL so commits do not wait on the disk", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-db-pragmas-"))
  roots.push(root)

  const database = openDatabase({ filename: join(root, "touri.db") })
  const journal = database.query("PRAGMA journal_mode").get() as { journal_mode: string }
  const synchronous = database.query("PRAGMA synchronous").get() as { synchronous: number }
  database.close()

  expect(journal.journal_mode).toBe("wal")
  expect(synchronous.synchronous).toBe(1)
})

test("the store keeps a 64 MB page cache so hot pages are not re-read from the disk", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-db-pragmas-"))
  roots.push(root)

  const database = openDatabase({ filename: join(root, "touri.db") })
  const cache = database.query("PRAGMA cache_size").get() as { cache_size: number }
  database.close()

  expect(cache.cache_size).toBe(-65536)
})
