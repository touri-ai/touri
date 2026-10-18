import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const cleanups = new Set<() => void>()
afterEach(() => {
  // Reverse only a fresh cleanup snapshot; the shared registry stays unchanged.
  Array.from(cleanups)
    .reverse()
    .forEach((cleanup) => {
      cleanup()
    })
  cleanups.clear()
})

// SQLite has no per-connection statement observer; this helper owns and restores
// the native-method spy, and forwards calls with their original receiver.
const getQueryRecorder = () => {
  const queries = spyOn(Database.prototype, "query")
  cleanups.add(() => {
    queries.mockRestore()
  })

  return () => queries.mock.calls.map(([sql]) => sql)
}

test("a current-store restart does not audit every foreign-key table", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-restart-budget-"))
  cleanups.add(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const filename = join(root, "touri.db")
  openDatabase({ filename }).close()
  const getQueries = getQueryRecorder()

  const reopened = openDatabase({ filename })
  cleanups.add(() => {
    reopened.close()
  })

  expect(getQueries()).not.toContain("PRAGMA foreign_key_check")
  expect(reopened.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
})
