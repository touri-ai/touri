import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { createServer } from "node:net"
import type { Kernel } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createThreadDeletionManager } from "../../src/store/thread-deletion"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const getFixture = (phase: string) => {
  const fixture = testKernel()
  fixture.db
    .query(
      "INSERT INTO thread_deletions(thread_id,bot_id,phase,created_at,updated_at) VALUES('closing','fixture',?,1,1)",
    )
    .run(phase)
  cleanups.add(fixture.close)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const log = mock<Kernel["log"]>(() => {})
  const kernel = Object.assign({}, fixture.kernel, { log })
  const drain = async () => {
    started.resolve()
    await release.promise
  }
  const getJob = () =>
    fixture.db.query("SELECT phase,error_code FROM thread_deletions WHERE thread_id = 'closing'").get()

  return Object.assign({}, fixture, { kernel, started, release, drain, log, getJob })
}

const drainPhases = ["stopping", "drain"]
drainPhases.forEach((phase) => {
  test(`dispose during ${phase} awaits the drain and preserves the resumable job`, async () => {
    const fixture = getFixture(phase)
    const manager = createThreadDeletionManager(fixture.kernel, undefined, fixture.drain)
    cleanups.add(() => manager.dispose())
    cleanups.add(fixture.release.resolve)
    await fixture.started.promise

    const stopped = manager.dispose()
    const again = manager.dispose()
    fixture.db.exec("PRAGMA query_only = ON")
    fixture.release.resolve()
    await stopped

    expect(stopped).toBeInstanceOf(Promise)
    expect(again).toBe(stopped)
    expect(fixture.getJob()).toEqual({ phase, error_code: null })
    expect(fixture.log).not.toHaveBeenCalled()
    manager.start()
    await manager.dispose()
  })
})

test("dispose cancels attachment collection without updating the job or publishing deletion", async () => {
  const fixture = getFixture("cleanup")
  fixture.db
    .query("INSERT INTO thread_deletion_attachments(thread_id,attachment_id) VALUES('closing','synthetic')")
    .run()
  const published = mock<Kernel["publish"]>(() => {})
  const kernel = Object.assign({}, fixture.kernel, { publish: published })
  const canceled = Promise.withResolvers<void>()
  const collect = mock(async (...args: Parameters<NonNullable<Parameters<typeof createThreadDeletionManager>[1]>>) => {
    const signal = args[7]
    if (!signal) throw new Error("Missing cleanup cancellation signal")
    signal.addEventListener("abort", () => canceled.resolve(), { once: true })
    fixture.started.resolve()
    await fixture.release.promise
    expect(signal.aborted).toBe(true)
    return 0
  })
  const manager = createThreadDeletionManager(kernel, collect)
  cleanups.add(() => manager.dispose())
  cleanups.add(fixture.release.resolve)
  await fixture.started.promise

  const stopped = manager.dispose()
  await canceled.promise
  fixture.db.exec("PRAGMA query_only = ON")
  fixture.release.resolve()
  await stopped

  expect(fixture.getJob()).toEqual({ phase: "cleanup", error_code: null })
  expect(fixture.db.query("SELECT attachment_id FROM thread_deletion_attachments").all()).toEqual([
    { attachment_id: "synthetic" },
  ])
  expect(published).not.toHaveBeenCalled()
  expect(fixture.log).not.toHaveBeenCalled()
})

const failureCases = [
  { state: "closed", operation: "write" },
  { state: "closed", operation: "drain" },
  { state: "read-only", operation: "drain" },
]
failureCases.forEach(({ state, operation }) => {
  test(`a ${state} database during ${operation} is logged without leaking the failure or rejecting shutdown`, async () => {
    const fixture = getFixture("drain")
    const logged = Promise.withResolvers<void>()
    const log = mock<Kernel["log"]>(() => logged.resolve())
    const kernel = Object.assign({}, fixture.kernel, { log })
    const manager = createThreadDeletionManager(kernel, undefined, async () => {
      await fixture.drain()
      if (operation === "drain") throw new Error("Synthetic private failure detail")
    })
    cleanups.add(() => manager.dispose())
    cleanups.add(fixture.release.resolve)
    await fixture.started.promise

    if (state === "closed") fixture.db.close()
    if (state === "read-only") fixture.db.exec("PRAGMA query_only = ON")
    fixture.release.resolve()
    await logged.promise
    await manager.dispose()

    expect(log.mock.calls).toEqual([
      [{ level: "warn", module: "store", msg: "Thread deletion status could not be saved" }],
    ])
  })
})

const workerBarriers = ["ready", "batch"]
workerBarriers.forEach((barrier) => {
  test(`dispose at worker ${barrier} waits for its connection owner to exit`, async () => {
    const fixture = getFixture("events")
    const stopped = Promise.withResolvers<void>()
    const exited = mock(() => {})
    const createWorker = mock((url: string) => {
      const worker = new Worker(url, { smol: true, ref: false })
      worker.addEventListener("close", exited)
      worker.addEventListener("message", ({ data }: MessageEvent<{ type: string }>) => {
        if (data.type !== barrier) return
        fixture.started.resolve()
        void manager.dispose().then(stopped.resolve, stopped.reject)
      })
      return worker
    })
    const manager = createThreadDeletionManager(fixture.kernel, undefined, undefined, createWorker)
    cleanups.add(() => manager.dispose())

    await fixture.started.promise
    await stopped.promise
    await manager.dispose()

    expect(createWorker).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledTimes(1)
    expect(fixture.getJob()).toMatchObject({ error_code: null })
    expect(fixture.log).not.toHaveBeenCalled()
  })
})

test("runtime shutdown keeps SQLite open until the active deletion settles", async () => {
  const fixture = getFixture("drain")
  const runtime = createKernel({
    appData: fixture.kernel.paths.appData,
    web: { hostname: "127.0.0.1", port: await getFreePort(), intercept: async () => null },
  })
  cleanups.add(() => runtime.stop())
  const manager = createThreadDeletionManager(runtime.kernel, undefined, fixture.drain)
  const disposing = Promise.withResolvers<void>()
  runtime.kernel.services.provide("storage.threadDeletion", {
    dispose: () => {
      disposing.resolve()
      return manager.dispose()
    },
  })
  cleanups.add(fixture.release.resolve)
  const database = runtime.kernel.db as Database
  const stopped = mock(() => {})
  await fixture.started.promise

  const stopping = runtime.stop().then(stopped)
  await disposing.promise
  await Promise.resolve()

  expect(stopped).not.toHaveBeenCalled()
  expect(database.query("SELECT 1 AS open").get()).toEqual({ open: 1 })
  fixture.release.resolve()
  await stopping
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(() => database.query("SELECT 1").get()).toThrow()
  expect(fixture.getJob()).toEqual({ phase: "drain", error_code: null })
})

const getFreePort = async (): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const server = createServer()
    const available = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error("No free synthetic test port")
}
