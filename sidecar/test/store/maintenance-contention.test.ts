import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorageMaintenance } from "../../src/kernel/data-maintenance"
import { openDatabase } from "../../src/kernel/db"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("maintenance defers a contended progress write without waiting on the event loop and retries after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-maintenance-contention-"))
  const database = openDatabase({ filename: join(root, "synthetic.db") })
  const blocker = new Database(database.filename)
  database.exec("PRAGMA busy_timeout = 300")
  const maintenance = createStorageMaintenance({
    database,
    appData: root,
    publishResync: () => {},
    retryDeletedBrowserSessionKeys: async () => {},
    onError: () => {},
  })
  cleanups.add(async () => {
    maintenance.dispose({ closing: true })
    if (blocker.inTransaction) blocker.exec("ROLLBACK")
    blocker.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  blocker.exec("BEGIN IMMEDIATE")

  const started = performance.now()
  maintenance.start()
  await waitUntil(() => Boolean(maintenance.snapshot().error))
  const attemptMs = performance.now() - started
  const restoredTimeout = database.query("PRAGMA busy_timeout").get()
  const blockedProgress = database.query("SELECT key FROM settings WHERE key = 'storage.maintenance.progress'").get()
  blocker.exec("ROLLBACK")
  await waitUntil(() => !maintenance.snapshot().running && !maintenance.snapshot().error)

  expect(attemptMs).toBeLessThan(150)
  expect(restoredTimeout).toEqual({ timeout: 300 })
  expect(blockedProgress).toBeNull()
  expect(database.query("SELECT key FROM settings WHERE key = 'storage.maintenance.progress'").get()).not.toBeNull()
  console.info(`storage-maintenance-lock-performance ${JSON.stringify({ attemptMs })}`)
})

const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error("Maintenance did not reach the expected state")
}
