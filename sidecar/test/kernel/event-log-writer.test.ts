import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEventEnvelope } from "@touri/contracts"
import { writeDatabaseAsync } from "../../src/kernel/database-write"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-event-write-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "test.db") })
  cleanups.add(() => database.close())
  const lock = new Database(database.filename)
  cleanups.add(() => lock.close())
  const bus = createEventBus(database)
  cleanups.add(() => bus.stop().catch(() => undefined))
  cleanups.add(() => {
    if (lock.inTransaction) lock.exec("ROLLBACK")
  })
  const received = new Map<number, UiEventEnvelope>()
  bus.subscribe((event) => received.set(event.seq, event))
  const controls = new Map<number, UiEventEnvelope>()
  bus.subscribeRuntime((event) => controls.set(event.seq, event))
  return { database, lock, bus, received, controls }
}

const getEvent = (done: number) => ({
  type: "import.progress" as const,
  importId: "fixture",
  phase: "saving",
  done,
  total: 3,
})
const getProgress = (envelopes: Iterable<UiEventEnvelope>) =>
  Array.from(envelopes).flatMap(({ event }) => (event.type === "import.progress" ? [event.done] : []))

test("a held SQLite writer never blocks event publication and flush waits for ordered durable delivery", async () => {
  const f = await makeFixture()
  f.lock.exec("BEGIN IMMEDIATE")
  const release = setTimeout(() => f.lock.exec("COMMIT"), 20)
  cleanups.add(() => clearTimeout(release))
  const startedAt = performance.now()

  f.bus.publish(getEvent(1))
  f.bus.publish(getEvent(2))
  const publicationMs = performance.now() - startedAt
  const controlsBeforeCommit = f.controls.size
  await f.bus.flushAsync()
  f.bus.publish(getEvent(3))
  await f.bus.flushAsync()

  expect(publicationMs).toBeLessThan(50)
  expect(controlsBeforeCommit).toBe(0)
  expect(getProgress(f.received.values())).toEqual([1, 2, 3])
  expect(getProgress(f.controls.values())).toEqual([1, 2, 3])
  const persisted = f.database.query("SELECT event_json FROM ui_event_log ORDER BY seq").all()
  expect(persisted).toHaveLength(3)
  expect(f.database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 })
})

test("shutdown drains admitted events before the database can close", async () => {
  const f = await makeFixture()
  f.lock.exec("BEGIN IMMEDIATE")
  const release = setTimeout(() => f.lock.exec("COMMIT"), 20)
  cleanups.add(() => clearTimeout(release))
  f.bus.publish(getEvent(1))

  await f.bus.stop()

  expect(f.database.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 1 })
  expect(f.received.size).toBe(0)
})

test("a transactional publication cannot overtake an admitted event or survive its own rollback", async () => {
  const f = await makeFixture()
  f.lock.exec("BEGIN IMMEDIATE")
  const release = setTimeout(() => f.lock.exec("COMMIT"), 20)
  cleanups.add(() => clearTimeout(release))
  f.bus.publish(getEvent(1))

  await writeDatabaseAsync(f.database, () => f.bus.publish(getEvent(2)))
  await f.bus.flushAsync()
  expect(() =>
    f.database.transaction(() => {
      f.bus.publish(getEvent(3))
      throw new Error("Synthetic rollback")
    })(),
  ).toThrow("Synthetic rollback")
  await f.bus.flushAsync()

  expect(getProgress(f.received.values())).toEqual([1, 2])
  expect(getProgress(f.controls.values())).toEqual([1, 2])
})

test("contended event buffering rejects overflow while preserving the admitted events", async () => {
  const f = await makeFixture()
  f.lock.exec("BEGIN IMMEDIATE")
  Array.from({ length: 2_000 }, (_, index) => f.bus.publish(getEvent(index)))

  expect(() => f.bus.publish(getEvent(2_000))).toThrow("EVENT_PERSISTENCE_CAPACITY")
  f.lock.exec("COMMIT")
  await f.bus.flushAsync()

  expect(f.database.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 2_000 })
  expect(f.received.size).toBe(2_000)
  expect(f.controls.size).toBe(2_000)
})

test("a failed insert inside a transaction never admits an uncommitted event", async () => {
  const f = await makeFixture()
  f.lock.exec("BEGIN IMMEDIATE")
  f.database.exec("BEGIN")
  cleanups.add(() => {
    if (f.database.inTransaction) f.database.exec("ROLLBACK")
  })

  expect(() => f.bus.publish(getEvent(1))).toThrow()
  f.database.exec("ROLLBACK")
  f.lock.exec("COMMIT")
  await f.bus.flushAsync()

  expect(f.received.size).toBe(0)
  expect(f.controls.size).toBe(0)
  expect(f.database.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 0 })
})

test("persistent storage failures reach flush and shutdown without delivering or retrying committed events", async () => {
  const f = await makeFixture()
  f.database.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON ui_event_log BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END",
  )
  f.lock.exec("BEGIN IMMEDIATE")
  f.bus.publish(getEvent(1))

  f.lock.exec("COMMIT")
  await expect(f.bus.flushAsync()).rejects.toThrow("EVENT_PERSISTENCE_FAILED")
  expect(() => f.bus.publish(getEvent(2))).toThrow("EVENT_PERSISTENCE_FAILED")
  await expect(f.bus.stop()).rejects.toThrow("EVENT_PERSISTENCE_FAILED")

  expect(f.received.size).toBe(0)
  expect(f.controls.size).toBe(0)
  expect(f.database.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 0 })
})
