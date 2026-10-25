import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { walCheckpointSource } from "../../src/kernel/wal-checkpoint-worker"
import { createWalCheckpointer } from "../../src/kernel/wal-checkpointer"

// Resource handles belong to one fixture and close before its files are removed.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("page reclamation releases a bounded batch in the worker and preserves live rows", async () => {
  const database = await getFixture()
  const initial = getFreePages(database)
  const reclaimed = Promise.withResolvers<number>()
  const checkpointer = createWalCheckpointer({
    database,
    intervalMs: 10,
    pageIntervalMs: 0,
    onError: () => reclaimed.reject(new Error("Maintenance failed")),
    createWorker: () => {
      // Hold maintenance after one real pass so the batch-size assertion cannot race another tick.
      const source = walCheckpointSource.replace("      reclaimPages();", "      reclaimPages(); clearInterval(timer);")
      const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
      cleanups.add(() => URL.revokeObjectURL(url))
      const worker = new Worker(url, { smol: true, ref: false })
      worker.addEventListener("message", ({ data }) => {
        if (data.type === "pages-reclaimed") reclaimed.resolve(data.pages)
      })
      return worker
    },
  })
  cleanups.add(checkpointer.dispose)

  const pages = await reclaimed.promise
  const remaining = getFreePages(database)

  expect(initial).toBeGreaterThan(1_000)
  expect(pages).toBeGreaterThan(0)
  expect(pages).toBeLessThanOrEqual(256)
  expect(initial - remaining).toBe(pages)
  expect(database.query("SELECT id,length(payload) AS bytes FROM fixture").all()).toEqual([{ id: 2048, bytes: 4096 }])
  console.info(JSON.stringify({ initialFreePages: initial, reclaimedPages: pages, remainingFreePages: remaining }))
})

test("default page maintenance attempts reclamation every five seconds", async () => {
  const database = await getFixture()
  const started = Promise.withResolvers<number>()
  const checkpointer = createWalCheckpointer({
    database,
    onError: () => started.reject(new Error("Maintenance failed")),
    createWorker: () => {
      const source = walCheckpointSource.replace(
        "    pageIntervalMs = data.pageIntervalMs;",
        '    pageIntervalMs = data.pageIntervalMs; self.postMessage({ type: "test-interval", intervalMs: pageIntervalMs });',
      )
      const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
      cleanups.add(() => URL.revokeObjectURL(url))
      const worker = new Worker(url, { smol: true, ref: false })
      worker.addEventListener("message", ({ data }) => {
        if (data.type === "test-interval") started.resolve(data.intervalMs)
      })
      return worker
    },
  })
  cleanups.add(checkpointer.dispose)

  const intervalMs = await started.promise

  expect(intervalMs).toBe(5_000)
})

const getFixture = async (): Promise<Database> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "touri-page-reclamation-")))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = new Database(join(root, "fixture.db"))
  cleanups.add(() => database.close())
  database.exec(`
    PRAGMA auto_vacuum=INCREMENTAL;
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE fixture(id INTEGER PRIMARY KEY, payload BLOB);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2048)
    INSERT INTO fixture SELECT x,zeroblob(4096) FROM n;
    DELETE FROM fixture WHERE id<2048;
    PRAGMA wal_checkpoint(TRUNCATE);
  `)

  return database
}

const getFreePages = (database: Database): number =>
  (database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
