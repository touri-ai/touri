import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import {
  applyTranscriptRetentionPlan,
  getTranscriptRetentionPlan,
  purgeReplayRows,
} from "../../src/kernel/transcript-storage"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("event boundary discovery commits bounded cursor pages and resumes on a fresh connection", async () => {
  const database = await getFixture()
  const first = getPlan(database)

  applyTranscriptRetentionPlan(database, first)
  const resumed = new Database(database.filename)
  cleanups.add(() => resumed.close())
  const second = getPlan(resumed)

  expect(first.events).toEqual([])
  expect(first.more).toBe(true)
  expect(first.eventScan.remaining).toBe(476)
  expect(second.eventScan.complete).toBe(true)
  expect(second.eventScan.cutoff).toBe(3000)
  expect(second.events.map(({ seq }) => seq)).toEqual(Array.from({ length: 32 }, (_, index) => (index + 1) * 3))
  expect(getFloor(resumed)).toBe("0")

  applyTranscriptRetentionPlan(resumed, second)
  const third = getPlan(resumed)

  expect(third.eventScan.cutoff).toBe(second.eventScan.cutoff)
  expect(third.eventScan.before).toBe(second.eventScan.before)
  expect(third.eventScan.complete).toBe(true)
  expect(getFloor(resumed)).toBe(String((getSequences(resumed)[0] ?? 3) - 3))
  const plan = resumed
    .query("EXPLAIN QUERY PLAN SELECT seq FROM ui_event_log WHERE seq<=? ORDER BY seq DESC LIMIT ?")
    .all(7500, 1024) as Array<{ detail: string }>
  expect(plan.map(({ detail }) => detail).join(" ")).toContain("SEARCH ui_event_log USING INTEGER PRIMARY KEY")
  expect(plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false)
})

test("sequence gaps and new events preserve the counted suffix while the prefix drains", async () => {
  const database = await getFixture()
  applyTranscriptRetentionPlan(database, getPlan(database))
  database.exec("INSERT INTO ui_event_log(seq,at,event_json) VALUES(8000,1,'{}')")

  await drainRetention(database)
  const retained = getSequences(database)
  await drainRetention(database)

  expect(retained).toEqual([...Array.from({ length: 1500 }, (_, index) => (index + 1001) * 3), 8000])
  expect(getSequences(database)).toEqual(retained.slice(1))
  expect(getFloor(database)).toBe("3003")
  expect(getPlan(database).eventScan).toMatchObject({ head: 8000, complete: true })
  expect(getPlan(database).more).toBe(false)
  expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
})

test("a purge invalidates both partial scans and plans discovered before the purge", async () => {
  const database = await getFixture()
  purgeReplayRows(database, [{ seq: 7500 }])
  applyTranscriptRetentionPlan(database, getPlan(database))
  const stale = getPlan(database)
  purgeReplayRows(database, [{ seq: 7497 }])
  const before = getSequences(database)

  const result = applyTranscriptRetentionPlan(database, stale)
  const restarted = getPlan(database)
  applyTranscriptRetentionPlan(database, restarted)
  await drainRetention(database)

  expect(result.more).toBe(true)
  expect(stale.eventScan.complete).toBe(true)
  expect(restarted.events).toEqual([])
  expect(restarted.eventScan.remaining).toBe(476)
  expect(getSequences(database)).toEqual(before.slice(-1500))
  expect(getFloor(database)).toBe("7500")
})

test("interrupted discovery commits no cursor and a policy change restarts the scan", async () => {
  const database = await getFixture()
  const first = getPlan(database)

  expect(() =>
    database.transaction(() => {
      applyTranscriptRetentionPlan(database, first)
      throw new Error("Synthetic rollback")
    })(),
  ).toThrow("Synthetic rollback")

  expect(getPlan(database)).toEqual(first)
  expect(database.query("SELECT value FROM schema_meta WHERE key='event_retention_scan'").get()).toBeNull()
  applyTranscriptRetentionPlan(database, first)
  const changed = getTranscriptRetentionPlan({ database, events: 0, maxAgeMs: Number.MAX_SAFE_INTEGER }, 0, 32)

  expect(changed?.eventScan).toMatchObject({ events: 0, cutoff: 7500, complete: true })
  expect(changed?.events).toHaveLength(32)
})

const getFixture = async (): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "touri-event-scan-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => database.close())
  const body = JSON.stringify({ type: "fixture.event", text: "x".repeat(4096) })
  database
    .query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2500)
    INSERT INTO ui_event_log(seq,at,event_json) SELECT x*3,1,? FROM n`)
    .run(body)

  return database
}

const getPlan = (database: Database) => {
  const plan = getTranscriptRetentionPlan({ database, events: 1500, maxAgeMs: Number.MAX_SAFE_INTEGER }, 0, 32)
  if (!plan) throw new Error("Missing synthetic event plan")

  return plan
}

const drainRetention = async (database: Database): Promise<void> => {
  for (const _batch of Array.from({ length: 100 })) {
    const result = applyTranscriptRetentionPlan(database, getPlan(database))
    if (!result.more) return

    await Bun.sleep(0)
  }
  throw new Error("Synthetic retention did not finish")
}

const getSequences = (database: Database): number[] =>
  (database.query("SELECT seq FROM ui_event_log ORDER BY seq").all() as Array<{ seq: number }>).map(({ seq }) => seq)

const getFloor = (database: Database): string =>
  (database.query("SELECT value FROM schema_meta WHERE key='ui_event_floor_seq'").get() as { value: string }).value
