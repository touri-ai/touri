import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { createEventLogWriter } from "../../src/kernel/event-log-writer"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { createMachineUpgrades, type MachineMetadata } from "../../src/vm/machine-upgrade"
import { fakeVmProvider } from "./fake-provider"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("upgrade admission yields to a contended writer and persists its journal with the candidate", async () => {
  const f = await makeFixture()
  f.lock.exec("BEGIN IMMEDIATE")
  const released = releaseWriter(f.lock)

  const upgrade = await f.upgrades.begin(f.previous, f.candidate)
  await released

  expect(f.upgrades.getPending(f.previous.bot_id)).toEqual(upgrade)
  expect(getMachine(f.database)).toEqual({ vm_id: f.candidate.vm_id, volume: f.candidate.volume })
  expect(f.database.inTransaction).toBe(false)
  expect(f.database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 })
})

test("rollback yields to another writer without stranding event persistence in a transaction", async () => {
  const f = await makeFixture()
  const upgrade = await f.upgrades.begin(f.previous, f.candidate)
  const saved = new Set<number>()
  const events = createEventLogWriter(f.database, ({ seq }) => saved.add(seq))
  cleanups.add(async () => {
    if (f.lock.inTransaction) f.lock.exec("ROLLBACK")
    await events.flushAsync()
  })
  f.lock.exec("BEGIN IMMEDIATE")
  events.save({ type: "import.progress", importId: "synthetic", phase: "saving", done: 1, total: 1 })
  const released = releaseWriter(f.lock)

  await f.upgrades.rollback(f.previous.bot_id, upgrade)
  await released
  await events.flushAsync()

  expect(getMachine(f.database)).toEqual({ vm_id: f.previous.vm_id, volume: f.previous.volume })
  expect(f.upgrades.getPending(f.previous.bot_id)).toBeNull()
  expect(f.database.inTransaction).toBe(false)
  expect(saved.size).toBe(1)
  expect(f.database.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 1 })
})

test("finishing an upgrade persists its committed journal before removing the original", async () => {
  const f = await makeFixture()
  const upgrade = await f.upgrades.begin(f.previous, f.candidate)
  f.lock.exec("BEGIN IMMEDIATE")
  const released = releaseWriter(f.lock)

  await f.upgrades.finish(f.previous.bot_id, upgrade)
  await released

  expect(getMachine(f.database)).toEqual({ vm_id: f.candidate.vm_id, volume: f.candidate.volume })
  expect(f.upgrades.getPending(f.previous.bot_id)).toBeNull()
  expect(f.removed.has(f.previous.vm_id)).toBe(true)
  expect(f.database.inTransaction).toBe(false)
})

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-upgrade-contention-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "test.db") })
  cleanups.add(() => database.close())
  // A failed native write must fail immediately; only the application owns retries.
  database.exec("PRAGMA busy_timeout = 0")
  const lock = new Database(database.filename)
  cleanups.add(() => lock.close())
  cleanups.add(() => {
    if (lock.inTransaction) lock.exec("ROLLBACK")
  })
  database
    .query("INSERT INTO bots(id, name, provider, home_dir, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run("synthetic-bot", "Synthetic", profileProviders[0], join(root, "bot"))
  const previous: MachineMetadata = {
    bot_id: "synthetic-bot",
    vm_id: "synthetic-original",
    volume: "synthetic-workspace",
    project_id: null,
    folder_fingerprint: "synthetic-folders",
    created_ms: 1,
    start_ms: 1,
  }
  const candidate = { ...previous, vm_id: "synthetic-candidate" }
  database
    .query("INSERT INTO bot_machines(bot_id, vm_id, volume, folder_fingerprint) VALUES (?, ?, ?, ?)")
    .run(previous.bot_id, previous.vm_id, previous.volume, previous.folder_fingerprint)
  const removed = new Set<string>()
  const upgrades = createMachineUpgrades(
    database,
    fakeVmProvider().provider,
    () => 1,
    async (id) => {
      removed.add(id)
    },
  )

  return { database, lock, previous, candidate, upgrades, removed }
}

const releaseWriter = (lock: Database): Promise<void> =>
  new Promise((resolve) => {
    const continuation = setImmediate(() => {
      if (lock.inTransaction) lock.exec("COMMIT")
      resolve()
    })
    cleanups.add(() => clearImmediate(continuation))
  })

const getMachine = (database: Database) => database.query("SELECT vm_id, volume FROM bot_machines").get()
