import type { Database } from "bun:sqlite"
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
