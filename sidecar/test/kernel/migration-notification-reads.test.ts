import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { createNotificationStore } from "../../src/notify/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("schema 51 upgrades without changing notification resolution and keeps receipts on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-read-migration-"))
  const filename = join(root, "touri.db")
  const original = openDatabase({ filename })
  const notice = createNotificationStore({ db: original }).insert({
    kind: "done",
    botId: null,
    threadId: null,
    title: "Resumo",
    body: "Pronto",
  }).notification
  original.exec("DROP TABLE notification_reads")
  original.query("UPDATE schema_meta SET value = '51' WHERE key = 'schema_version'").run()
  original.close()
  const database = openDatabase({ filename })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  const store = createNotificationStore({ db: database, now: () => 100 })
  const marked = store.markRead("person-demo", [notice])

  expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: "52" })
  expect(marked[0]).toMatchObject({ readAt: 100, resolvedAt: null, resolution: null })
  expect(store.get(notice.id)).toEqual(notice)
})

test("receipt projections use composite key seeks and notification deletion uses its reverse index", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-read-plan-"))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  database.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 10000)
    INSERT INTO notifications(id,kind,level,title,body,created_at) SELECT id,'done','info','Resumo','Pronto',1 FROM ids`)
  database.exec("INSERT INTO notification_reads SELECT 'person-demo', id, 10 FROM notifications")

  const projection = getPlan(
    database,
    "SELECT notification_id, read_at FROM notification_reads WHERE person_id = ? AND notification_id IN (?, ?)",
    ["person-demo", 1, 10000],
  )
  const deletion = getPlan(database, "SELECT person_id FROM notification_reads WHERE notification_id = ?", [1])
  const store = createNotificationStore({ db: database })
  const recent = store.recent(500)
  const samples = Array.from({ length: 100 }, () => {
    const started = process.cpuUsage()
    expect(store.getForPerson("person-demo", recent)).toHaveLength(500)
    const elapsed = process.cpuUsage(started)

    return (elapsed.user + elapsed.system) / 1000
  })
  // ES2022 lacks immutable sorting; this measurement array is local to the test.
  const p99 = samples.sort((left, right) => left - right)[98] ?? 0
  database.query("DELETE FROM notifications WHERE id = ?").run(1)

  console.info(`Receipt projection: 10,000 notices, 500 results, 100 samples, CPU p99 ${p99.toFixed(2)}ms`)
  expect(p99).toBeLessThan(50)
  expect(projection).toContain(
    "SEARCH notification_reads USING INDEX sqlite_autoindex_notification_reads_1 (person_id=? AND notification_id=?)",
  )
  expect(deletion).toContain(
    "SEARCH notification_reads USING INDEX notification_reads_notification (notification_id=?)",
  )
  expect(database.query("SELECT count(*) AS total FROM notification_reads WHERE notification_id = 1").get()).toEqual({
    total: 0,
  })
})

const getPlan = (database: Database, sql: string, parameters: Array<string | number>) => {
  const statement = database.query(`EXPLAIN QUERY PLAN ${sql}`)
  const rows = statement.all.apply(statement, parameters) as Array<{ detail: string }>

  return rows.map((row) => row.detail).join("\n")
}
