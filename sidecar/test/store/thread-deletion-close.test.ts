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

test("dispose terminates an unresponsive batch before awaiting its completion", async () => {
  const fixture = getFixture("events")
  const exited = mock(() => {})
  const source = `self.onmessage = ({ data }) => {
    if (data.type === "start") self.postMessage({ type: "ready" });
    if (data.type === "batch") self.postMessage({ type: "held" });
  };`
  const workerUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  cleanups.add(() => URL.revokeObjectURL(workerUrl))
  const createWorker = () => {
    const worker = new Worker(workerUrl, { smol: true, ref: false })
    worker.addEventListener("close", exited)
    worker.addEventListener("message", ({ data }: MessageEvent<{ type: string }>) => {
      if (data.type === "held") fixture.started.resolve()
    })
    cleanups.add(() => worker.terminate())
    return worker
  }
  const manager = createThreadDeletionManager(fixture.kernel, undefined, undefined, createWorker)
  cleanups.add(() => manager.dispose())
  await fixture.started.promise

  await manager.dispose()

  expect(exited).toHaveBeenCalledTimes(1)
  expect(fixture.getJob()).toEqual({ phase: "events", error_code: null })
  expect(fixture.log.mock.calls).toEqual([
    [{ level: "warn", module: "store", msg: "Thread deletion worker shutdown required termination" }],
  ])
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

const getBoundProperty = (target: object, property: string | symbol) => {
  const value = Reflect.get(target, property, target)
  return typeof value === "function" ? value.bind(target) : value
}

const getIdleScanDatabase = (database: Database, onIdle: () => void): Database => {
  const query = database.query.bind(database)
  const scan = "SELECT * FROM thread_deletions ORDER BY created_at, thread_id LIMIT 1"
  const scanned = mock(onIdle)
  const getStatement = (sql: string) => {
    const statement = query(sql)
    if (sql !== scan) return statement

    const all = () => {
      const rows = statement.all()
      if (rows.length || scanned.mock.calls.length) return rows

      scanned()
      return rows
    }
    return new Proxy(statement, {
      get: (target, property) => (property === "all" ? all : getBoundProperty(target, property)),
    })
  }
  return new Proxy(database, {
    get: (target, property) => (property === "query" ? getStatement : getBoundProperty(target, property)),
  })
}

test("a deletion accepted while the idle scan settles starts without another request", async () => {
  const fixture = getFixture("cleanup")
  fixture.db.query("DELETE FROM thread_deletions").run()
  const accepted = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const database = getIdleScanDatabase(fixture.db, () => {
    // The empty scan has returned, but its promise has not cleared the active job yet.
    queueMicrotask(() => {
      fixture.db
        .query(`INSERT INTO thread_deletions(thread_id,bot_id,phase,created_at,updated_at)
          VALUES('accepted','fixture','cleanup',1,1)`)
        .run()
      manager.start()
      accepted.resolve()
    })
  })
  const published = mock<Kernel["publish"]>(() => finished.resolve())
  const kernel = Object.assign({}, fixture.kernel, { db: database, publish: published })
  const manager = createThreadDeletionManager(kernel)
  cleanups.add(() => manager.dispose())

  await accepted.promise
  await finished.promise
  await manager.dispose()

  expect(published).toHaveBeenCalledTimes(1)
  expect(fixture.db.query("SELECT * FROM thread_deletions").all()).toEqual([])
  expect(fixture.log).not.toHaveBeenCalled()
})
