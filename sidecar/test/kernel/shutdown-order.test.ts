import { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"

// The teardown registry owns only resources created by this file's fixtures.
const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("shutdown cancels independent services before waiting for SQLite owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-shutdown-order-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const desktopDisposed = mock(() => {})
  const doctorDisposed = mock(() => {})
  runtime.kernel.services.provide("vm.desktop", {
    claim: () => false,
    open: () => undefined,
    message: () => undefined,
    close: () => undefined,
    revokeControl: () => undefined,
    closeBot: async () => undefined,
    dispose: desktopDisposed,
  })
  runtime.kernel.services.provide("doctor", {
    start: () => {},
    dispose: doctorDisposed,
    snapshot: () => ({ checks: [], checkedAt: null, running: false }),
    settled: async () => {},
  })

  const stopped = runtime.stop()

  expect(desktopDisposed).toHaveBeenCalledTimes(1)
  expect(doctorDisposed).toHaveBeenCalledTimes(1)
  expect(existsSync(join(runtime.kernel.paths.runDir, "handshake.json"))).toBe(false)
  expect(runtime.stop()).toBe(stopped)
  await stopped
  expect(() => (runtime.kernel.db as Database).query("SELECT 1").get()).toThrow()
})

test("a deferred shutdown observer still receives persistence failure after the database closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-shutdown-failure-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  const lock = new Database(database.filename)
  cleanups.add(async () => {
    if (lock.inTransaction) lock.exec("ROLLBACK")
    lock.close()
    await runtime.stop().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })
  database.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON ui_event_log BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END",
  )
  lock.exec("BEGIN IMMEDIATE")
  runtime.kernel.publish({ type: "import.progress", importId: "fixture", phase: "saving", done: 1, total: 1 })

  const stopped = runtime.stop()
  lock.exec("COMMIT")
  await getDatabaseClosed(database)
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(runtime.stop()).toBe(stopped)
  await expect(stopped).rejects.toThrow("EVENT_PERSISTENCE_FAILED")
  expect(lock.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 0 })
})

const getDatabaseClosed = async (database: Database): Promise<void> => {
  const deadline = performance.now() + 5_000
  for (;;) {
    try {
      database.query("SELECT 1").get()
    } catch {
      return
    }
    if (performance.now() >= deadline) throw new Error("Shutdown did not close the database")
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}
