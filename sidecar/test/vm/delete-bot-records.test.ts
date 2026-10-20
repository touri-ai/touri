import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { botDeletionRecordTasks } from "../../src/vm/delete-bot-records"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("record deletion and its foreign-key checks use indexed lookups inside each primary-key window", async () => {
  const database = await getDatabase()

  const plans = botDeletionRecordTasks.flatMap((task) => {
    const action = task.update ? `UPDATE ${task.table} SET ${task.update}` : `DELETE FROM ${task.table}`
    const rows = database
      .query(`EXPLAIN QUERY PLAN ${action} WHERE rowid = ?1 AND (${task.predicate})`)
      .all(1, "synthetic-bot") as Array<{ detail: string }>

    return rows.map(({ detail }) => ({ table: task.table, detail }))
  })

  expect(plans.length).toBeGreaterThan(botDeletionRecordTasks.length)
  expect(plans.filter(({ detail }) => /\bSCAN\b/u.test(detail))).toEqual([])
})

const getDatabase = async (): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "touri-deletion-plans-"))
  const database = openDatabase({ filename: join(root, "synthetic.db") })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  return database
}
