import { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWalCheckpointer } from "../../src/kernel/wal-checkpointer"

// Resource handles are registered per test and released in reverse acquisition order.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("the embedded worker checkpoints WAL frames so the next write resets its size", async () => {
  const { database, walPath } = await getFixture()
  const ready = Promise.withResolvers<void>()
  const checkpointed = Promise.withResolvers<void>()
  const checkpointer = createWalCheckpointer({
    database,
    intervalMs: 10,
    onReady: ready.resolve,
    onError: () => ready.reject(new Error("Checkpoint worker failed")),
    createWorker: (url) => {
      const worker = new Worker(url, { smol: true, ref: false })
      worker.addEventListener("message", ({ data }) => {
        if (data?.type === "checkpoint" && data.log > 128 && data.checkpointed === data.log) checkpointed.resolve()
      })
      return worker
    },
  })
  cleanups.add(checkpointer.dispose)

  await ready.promise
  writeLargeBatch(database)
  const beforeBytes = (await stat(walPath)).size
  await checkpointed.promise
  database.exec("INSERT INTO fixture(payload) VALUES ('after checkpoint')")
  const afterBytes = (await stat(walPath)).size

  console.info(`wal-checkpoint-worker ${JSON.stringify({ beforeBytes, afterBytes })}`)
  expect(beforeBytes).toBeGreaterThan(256 * 1024)
  expect(afterBytes).toBeLessThan(beforeBytes / 2)
  expect(getAutocheckpointPages(database)).toBe(0)
  expect(database.query("SELECT COUNT(*) AS count FROM fixture").get()).toEqual({ count: 129 })
})

test("a constructor failure restores autocheckpointing and subsequent commits reset the WAL", async () => {
  const { database, walPath } = await getFixture()
  database.exec("PRAGMA wal_autocheckpoint = 1")
  const onError = mock(() => {})
  const checkpointer = createWalCheckpointer({
    database,
    onError,
    createWorker: () => {
      throw new Error("Synthetic worker startup failure")
    },
  })
  cleanups.add(checkpointer.dispose)

  writeLargeBatch(database)
  const beforeBytes = (await stat(walPath)).size
  database.exec("INSERT INTO fixture(payload) VALUES ('after fallback')")
  const afterBytes = (await stat(walPath)).size
  checkpointer.dispose()
  checkpointer.dispose()

  console.info(`wal-checkpoint-fallback ${JSON.stringify({ beforeBytes, afterBytes })}`)
  expect(getAutocheckpointPages(database)).toBe(1)
  expect(beforeBytes).toBeGreaterThan(256 * 1024)
  expect(afterBytes).toBeLessThan(beforeBytes / 2)
  expect(onError).toHaveBeenCalledTimes(1)
})

test("an unexpected worker exit restores a positive checkpoint threshold and reports once", async () => {
  const { database } = await getFixture()
  const ready = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<void>()
  const onError = mock(() => {
    ready.reject(new Error("Checkpoint worker failed before ready"))
    failed.resolve()
  })
  // Capture the owned handle to simulate a real worker dying after startup.
  let worker: Worker | undefined
  const checkpointer = createWalCheckpointer({
    database,
    onReady: ready.resolve,
    onError,
    createWorker: (url) => {
      worker = new Worker(url, { smol: true, ref: false })
      return worker
    },
  })
  cleanups.add(checkpointer.dispose)

  await ready.promise
  expect(getAutocheckpointPages(database)).toBe(0)
  worker?.terminate()
  await failed.promise

  expect(getAutocheckpointPages(database)).toBe(1_000)
  expect(onError).toHaveBeenCalledTimes(1)
})

test("an asynchronous worker startup error enables fallback without a second report on exit", async () => {
  const { database } = await getFixture()
  const failed = Promise.withResolvers<void>()
  const onError = mock(failed.resolve)
  const checkpointer = createWalCheckpointer({
    database,
    onError,
    createWorker: () => {
      const url = URL.createObjectURL(new Blob(['throw new Error("Synthetic worker error")']))
      cleanups.add(() => URL.revokeObjectURL(url))
      return new Worker(url, { smol: true, ref: false })
    },
  })
  cleanups.add(checkpointer.dispose)

  await failed.promise
  checkpointer.dispose()

  expect(getAutocheckpointPages(database)).toBe(1_000)
  expect(onError).toHaveBeenCalledTimes(1)
})

test("disposing a healthy checkpointer restores SQLite maintenance for a still-open connection", async () => {
  const { database } = await getFixture()
  database.exec("PRAGMA wal_autocheckpoint = 32")
  const ready = Promise.withResolvers<void>()
  const onError = mock(() => ready.reject(new Error("Checkpoint worker failed")))
  const checkpointer = createWalCheckpointer({ database, onReady: ready.resolve, onError })
  cleanups.add(checkpointer.dispose)

  await ready.promise
  checkpointer.dispose()
  checkpointer.dispose()

  expect(getAutocheckpointPages(database)).toBe(32)
  expect(onError).not.toHaveBeenCalled()
})

test("shutdown can dispose maintenance after its database connection has already closed", async () => {
  const { database } = await getFixture()
  const ready = Promise.withResolvers<void>()
  const onError = mock(() => ready.reject(new Error("Checkpoint worker failed")))
  const checkpointer = createWalCheckpointer({ database, onReady: ready.resolve, onError })
  cleanups.add(() => checkpointer.dispose({ closing: true }))
  await ready.promise

  database.close()

  expect(() => checkpointer.dispose({ closing: true })).not.toThrow()
  expect(onError).not.toHaveBeenCalled()
})

const getFixture = async () => {
  // SQLite's no-follow open rejects directory aliases as well as a symlinked database.
  const root = await realpath(await mkdtemp(join(tmpdir(), "touri-wal-checkpointer-")))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, "fixture.db")
  const database = new Database(filename)
  cleanups.add(() => database.close())
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = 0")
  database.exec("CREATE TABLE fixture(payload TEXT)")

  return { database, walPath: `${filename}-wal` }
}

const getAutocheckpointPages = (database: Database): number =>
  (database.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint

const writeLargeBatch = (database: Database): void => {
  const insert = database.query("INSERT INTO fixture(payload) VALUES (?)")
  database.transaction(() => {
    Array.from({ length: 128 }, () => insert.run("x".repeat(4_096)))
  })()
}
