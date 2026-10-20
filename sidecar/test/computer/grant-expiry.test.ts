import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createComputerController } from "../../src/computer/controller"
import { createGrantStore } from "../../src/computer/grants"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createPerformanceStageTracker } from "../../src/kernel/performance"

const cleanups = new Set<() => void>()
afterEach(() => {
  // Reverse only the cleanup snapshot so dependent resources close first.
  Array.from(cleanups)
    .reverse()
    .forEach((cleanup) => {
      cleanup()
    })
  cleanups.clear()
})

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-grant-expiry-"))
  cleanups.add(() => {
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

test("schema 28 upgrades grant expiry to an indexed range seek and preserves history", () => {
  const filename = join(makeRoot(), "touri.db")
  const previous = openDatabase({ filename })
  previous.exec(`
    DROP INDEX computer_grants_active_expiry;
    UPDATE schema_meta SET value='28' WHERE key='schema_version';
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Synthetic','codex','/tmp',1,1);
    INSERT INTO computer_grants(id,bot_id,granted_at,expires_at,revoked_at,revoked_by)
      VALUES ('revoked','b',1,10,5,'user'), ('expired','b',1,10,NULL,NULL), ('active','b',1,100,NULL,NULL);
  `)
  previous.close()
  const database = openDatabase({ filename })
  cleanups.add(() => {
    database.close()
  })

  const plan = database
    .query(`EXPLAIN QUERY PLAN UPDATE computer_grants SET revoked_at=?,revoked_by='expiry'
      WHERE revoked_at IS NULL AND expires_at<=?`)
    .all(50, 50) as Array<{ detail: string }>
  database
    .query("UPDATE computer_grants SET revoked_at=50,revoked_by='expiry' WHERE revoked_at IS NULL AND expires_at<=50")
    .run()

  expect(plan.some((row) => /SEARCH computer_grants USING INDEX computer_grants_active_expiry/.test(row.detail))).toBe(
    true,
  )
  expect(database.query("SELECT id,revoked_at,revoked_by FROM computer_grants ORDER BY id").all()).toEqual([
    { id: "active", revoked_at: null, revoked_by: null },
    { id: "expired", revoked_at: 50, revoked_by: "expiry" },
    { id: "revoked", revoked_at: 5, revoked_by: "user" },
  ])
})

test("the periodic computer expiry pass records its own performance stage", async () => {
  const runtime = createKernel({ appData: makeRoot() })
  cleanups.add(runtime.stop)
  const stages = createPerformanceStageTracker(() => 0)
  const controller = createComputerController(runtime.kernel, { runStage: stages.run })
  cleanups.add(controller.dispose)
  const database = runtime.kernel.db as Database
  const before = database.query("SELECT COUNT(*) AS n FROM computer_grants").get()
  const deadline = Date.now() + 2500

  while (!stages.snapshot().some((timing) => timing.stage === "computer_grant_expiry") && Date.now() < deadline)
    await Bun.sleep(10)

  expect(stages.snapshot()).toContainEqual(expect.objectContaining({ stage: "computer_grant_expiry", calls: 1 }))
  expect(database.query("SELECT COUNT(*) AS n FROM computer_grants").get()).toEqual(before)
})

test("idle computer expiry skips writes while another connection owns the database", () => {
  const { database, writer, grants } = getGrantFixture()
  writer.exec("BEGIN IMMEDIATE")
  const started = performance.now()

  const expired = grants.expire()

  expect(expired).toBe(0)
  expect(performance.now() - started).toBeLessThan(200)
  expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
  writer.exec("ROLLBACK")
}, 15_000)

test("busy expiry defers bookkeeping while expired computer grants remain denied", () => {
  const { database, writer, grants } = getGrantFixture()
  database.exec(
    "INSERT INTO computer_grants(id,bot_id,thread_id,granted_at,expires_at) VALUES ('expired','b','thread',1,10)",
  )
  writer.exec("BEGIN IMMEDIATE")
  const started = performance.now()

  const expired = grants.expire()

  expect(expired).toBe(0)
  expect(performance.now() - started).toBeLessThan(200)
  expect(grants.active({ botId: "b", threadId: "thread" })).toBeNull()
  expect(database.query("SELECT revoked_at FROM computer_grants WHERE id='expired'").get()).toEqual({
    revoked_at: null,
  })
  expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
  writer.exec("ROLLBACK")

  expect(grants.expire()).toBe(1)
  expect(database.query("SELECT revoked_at,revoked_by FROM computer_grants WHERE id='expired'").get()).toEqual({
    revoked_at: 100,
    revoked_by: "expiry",
  })
})

test("computer expiry commits at most fifty overdue grants per pass", () => {
  const { database, grants } = getGrantFixture()
  const insert = database.query(
    "INSERT INTO computer_grants(id,bot_id,thread_id,granted_at,expires_at) VALUES (?,'b','thread',1,10)",
  )
  Array.from({ length: 51 }, (_, index) => `expired-${index}`).forEach((id) => {
    insert.run(id)
  })
  database.exec(
    "INSERT INTO computer_grants(id,bot_id,thread_id,granted_at,expires_at) VALUES ('future','b','thread',1,1000)",
  )

  const expired = grants.expire()

  expect(expired).toBe(50)
  expect(database.query("SELECT COUNT(*) AS n FROM computer_grants WHERE revoked_by='expiry'").get()).toEqual({ n: 50 })
  expect(grants.active({ botId: "b", threadId: "thread" })?.id).toBe("future")
  expect(grants.expire()).toBe(1)
  expect(grants.expire()).toBe(0)
})

const getGrantFixture = () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  cleanups.add(runtime.stop)
  const database = runtime.kernel.db as Database
  database.exec(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Synthetic','codex','.',1,1)",
  )
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','b','Synthetic',1,1)")
  const writer = new Database(join(root, "touri.db"))
  cleanups.add(() => {
    writer.close()
  })

  return { database, writer, grants: createGrantStore({ kernel: runtime.kernel, now: () => 100 }) }
}
