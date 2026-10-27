import { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createStoreReader } from "../../src/store/reader"

// Every fixture owns its database, helper handles and cleanup order.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("history reads consume one prepared helper and replenish only after completion", async () => {
  const { database, children, startProcess, onReady, reader } = await getFixture(true)
  expect(startProcess).toHaveBeenCalledTimes(1)
  const first = Array.from(children)[0]

  const rows = await reader.getRows({ sql: "SELECT value FROM fixture", bindings: [] }, AbortSignal.timeout(5_000))

  expect(rows).toEqual([{ value: "first" }])
  expect(onReady).toHaveBeenCalledWith(first?.pid)
  expect(startProcess).toHaveBeenCalledTimes(2)
  const second = Array.from(children)[1]
  database.exec("INSERT INTO fixture VALUES ('second')")

  const fresh = await reader.getRows(
    { sql: "SELECT value FROM fixture ORDER BY rowid", bindings: [] },
    AbortSignal.timeout(5_000),
  )

  expect(fresh).toEqual([{ value: "first" }, { value: "second" }])
  expect(onReady).toHaveBeenCalledWith(second?.pid)
  expect(startProcess).toHaveBeenCalledTimes(3)
})

test("disposing an idle reader terminates its prepared helper without replacing it", async () => {
  const { children, startProcess, reader } = await getFixture(true)
  const child = Array.from(children)[0]
  if (!child) throw new Error("Missing prepared helper")

  reader.dispose()
  await child.exited

  expect(startProcess).toHaveBeenCalledTimes(1)
  await expect(
    reader.getRows({ sql: "SELECT value FROM fixture", bindings: [] }, AbortSignal.timeout(5_000)),
  ).rejects.toThrow("STORE_READ_CAPACITY")
})

test("secondary readers remain lazy and do not retain an idle process", async () => {
  const { startProcess, reader } = await getFixture(false)
  expect(startProcess).not.toHaveBeenCalled()

  await reader.getRows({ sql: "SELECT value FROM fixture", bindings: [] }, AbortSignal.timeout(5_000))

  expect(startProcess).toHaveBeenCalledTimes(1)
})

test("failed background preparation falls back to an ordinary request and prepares again", async () => {
  const { children, startProcess, reader } = await getFixture(true, 1)
  expect(children.size).toBe(0)

  const rows = await reader.getRows({ sql: "SELECT value FROM fixture", bindings: [] }, AbortSignal.timeout(5_000))

  expect(rows).toEqual([{ value: "first" }])
  expect(startProcess).toHaveBeenCalledTimes(3)
})

test("request spawn failures release both read slots so the next read can recover", async () => {
  const { reader } = await getFixture(false, 2)
  const read = () => reader.getRows({ sql: "SELECT value FROM fixture", bindings: [] }, AbortSignal.timeout(5_000))

  await expect(read()).rejects.toThrow("STORE_READ_FAILED")
  await expect(read()).rejects.toThrow("STORE_READ_FAILED")
  const rows = await read()

  expect(rows).toEqual([{ value: "first" }])
})

const getFixture = async (prewarm: boolean, failedStarts = 0) => {
  const directory = await mkdtemp(join(tmpdir(), "touri-reader-prewarm-"))
  cleanups.add(() => rm(directory, { recursive: true, force: true }))
  const database = new Database(join(directory, "fixture.db"))
  cleanups.add(() => database.close())
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('first')")
  const children = new Set<Bun.Subprocess<"pipe", "pipe", "ignore">>()
  const startProcess = mock((): Bun.Subprocess<"pipe", "pipe", "ignore"> => {
    if (startProcess.mock.calls.length <= failedStarts) throw new Error("Synthetic process startup failure")
    const source = fileURLToPath(new URL("../../src/store/read-process.ts", import.meta.url))
    const child = Bun.spawn([process.execPath, source, "store-read"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    children.add(child)
    return child
  })
  cleanups.add(async () => {
    children.forEach((child) => {
      child.kill("SIGKILL")
    })
    await Promise.all(Array.from(children, (child) => child.exited))
  })
  const onReady = mock(() => {})
  const reader = createStoreReader(database.filename, onReady, { prewarm, startProcess })
  cleanups.add(reader.dispose)

  return { database, children, startProcess, onReady, reader }
}
