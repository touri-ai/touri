import { Database as SqliteDatabase } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEvent } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createStreamPersistence, STREAM_PERSISTENCE_LIMITS } from "../../src/store/stream-persistence"
import { streamPersistenceWorkerSource } from "../../src/store/stream-persistence-worker"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

const getFixture = async (
  createWorker?: (url: string) => Worker,
  prepare?: (database: ReturnType<typeof openDatabase>) => void,
  readyWaitLimitMs?: number,
  onReadyWaitExceeded?: () => void,
) => {
  const root = await mkdtemp(join(tmpdir(), "touri-stream-persistence-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => database.close())
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic','codex','.',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('other','bot','Synthetic',1,1)`)
  const threadIds = ["thread", "other"]
  threadIds.forEach((threadId) => {
    database
      .query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
      VALUES ('reply',?,'assistant','text','streaming','','[{"type":"text","text":""}]',1,1)`)
      .run(threadId)
  })
  prepare?.(database)
  const published: UiEvent[] = []
  const errors: number[] = []
  const persistence = createStreamPersistence({
    database,
    publish: (event) => published.push(event),
    onError: () => errors.push(Date.now()),
    ...(createWorker ? { createWorker } : {}),
    ...(readyWaitLimitMs === undefined ? {} : { readyWaitLimitMs }),
    ...(onReadyWaitExceeded ? { onReadyWaitExceeded } : {}),
  })
  cleanups.add(() => persistence.close())
  return { database, persistence, published, errors }
}

const getDelta = (threadId = "thread", delta = "durable") => ({
  type: "message.delta" as const,
  threadId,
  messageId: "reply",
  partIndex: 0,
  partType: "text" as const,
  delta,
  offset: 0,
  generation: 1,
  updatedAt: 2,
})

const createSourceWorker = (source: string): Worker => {
  const diagnosticSource = source.replace("busy: isBusy(error) });", "busy: isBusy(error), detail: String(error) });")
  const diagnosticUrl = URL.createObjectURL(new Blob([diagnosticSource], { type: "application/javascript" }))
  const worker = new Worker(diagnosticUrl, { smol: true, ref: false })
  worker.addEventListener("message", ({ data }) => {
    if (data.type === "batch-error" && !data.busy) console.info("synthetic-stream-error", data.detail)
  })
  cleanups.add(() => {
    worker.terminate()
    URL.revokeObjectURL(diagnosticUrl)
  })
  return worker
}

test("the controller retries a worker lost after commit and publishes exactly once from journal references", async () => {
  let starts = 0
  let observedCommitted = false
  const f = await getFixture(() => {
    starts += 1
    const source =
      starts === 1
        ? streamPersistenceWorkerSource.replace(
            "self.postMessage(result);",
            `
          self.postMessage({ type: "test-committed" });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        `,
          )
        : streamPersistenceWorkerSource
    const worker = createSourceWorker(source)
    worker.addEventListener("message", ({ data }) => {
      if (data.type !== "test-committed") return
      observedCommitted =
        (f.database.query("SELECT text FROM messages WHERE thread_id='thread'").get() as { text: string }).text ===
        "durable"
      worker.terminate()
    })
    return worker
  })

  await f.persistence.submit([getDelta()])

  expect(starts).toBe(2)
  expect(observedCommitted).toBe(true)
  expect(f.published.filter((event) => event.type === "message.delta")).toHaveLength(1)
  expect(f.database.query("SELECT text FROM messages WHERE thread_id='thread'").get()).toEqual({ text: "durable" })
  expect(
    f.database
      .query("SELECT COUNT(*) AS n FROM transcript_entries WHERE json_extract(event_json,'$.type')='message.delta'")
      .get(),
  ).toEqual({ n: 1 })
  expect(
    f.database
      .query("SELECT COUNT(*) AS n FROM ui_event_log WHERE json_extract(event_json,'$.type')='message.delta'")
      .get(),
  ).toEqual({ n: 1 })
  const saved = f.database.query("SELECT result_json FROM stream_writer_state").get() as { result_json: string }
  expect(JSON.parse(saved.result_json)).toEqual({ entryIds: [expect.any(Number)] })
  expect(saved.result_json).not.toContain("durable")
})

test("the controller retries a worker killed inside its transaction after rollback", async () => {
  let starts = 0
  let observedUncommitted = false
  const f = await getFixture(() => {
    starts += 1
    if (starts !== 1) return createSourceWorker(streamPersistenceWorkerSource)
    const source = streamPersistenceWorkerSource.replace(
      "database.transaction(() => writeBatch(data.batch)).immediate()",
      `database.transaction(() => {
        const result = writeBatch(data.batch);
        self.postMessage({ type: "test-transaction" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        return result;
      }).immediate()`,
    )
    const worker = createSourceWorker(source)
    worker.addEventListener("message", ({ data }) => {
      if (data.type !== "test-transaction") return
      observedUncommitted =
        (f.database.query("SELECT text FROM messages WHERE thread_id='thread'").get() as { text: string }).text === ""
      worker.terminate()
    })
    return worker
  })

  await f.persistence.submit([getDelta()])

  expect(observedUncommitted).toBe(true)
  expect(starts).toBe(2)
  expect(f.published.filter((event) => event.type === "message.delta")).toHaveLength(1)
  expect(f.database.query("SELECT text FROM messages WHERE thread_id='thread'").get()).toEqual({ text: "durable" })
  expect(
    f.database
      .query("SELECT COUNT(*) AS n FROM transcript_entries WHERE json_extract(event_json,'$.type')='message.delta'")
      .get(),
  ).toEqual({ n: 1 })
})

test("a permanent batch error backs off, records a rejection and lets another thread commit", async () => {
  const attempts: number[] = []
  const f = await getFixture(() => {
    const worker = createSourceWorker(streamPersistenceWorkerSource)
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "batch-error") attempts.push(performance.now())
    })
    return worker
  })
  await f.persistence.ready
  f.database.exec(`CREATE TRIGGER fail_stream BEFORE INSERT ON transcript_entries
    WHEN NEW.thread_id = 'thread' AND json_extract(NEW.event_json,'$.type') = 'message.delta'
    BEGIN SELECT RAISE(ABORT, 'Synthetic permanent failure'); END`)

  const poison = f.persistence.submit([getDelta()])
  const healthy = f.persistence.submit([getDelta("other")])
  const [rejected, committed] = await Promise.all([poison, healthy])

  expect(attempts).toHaveLength(4)
  expect((attempts[1] ?? 0) - (attempts[0] ?? 0)).toBeGreaterThanOrEqual(80)
  expect((attempts[2] ?? 0) - (attempts[1] ?? 0)).toBeGreaterThanOrEqual(180)
  expect(rejected.events).toHaveLength(0)
  expect(rejected.rejected).toHaveLength(1)
  expect(committed.events).toHaveLength(1)
  expect(f.database.query("SELECT text FROM messages WHERE thread_id='other'").get()).toEqual({ text: "durable" })
  expect(f.errors).toHaveLength(1)
})

test("startup materialization failure has a finite retry budget and rejects buffered work with resync", async () => {
  let starts = 0
  const f = await getFixture(
    () => {
      starts += 1
      return createSourceWorker(streamPersistenceWorkerSource)
    },
    (database) => {
      const broken = { ...getDelta(), offset: 99, updatedSeq: 2 }
      database
        .query("INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at) VALUES ('thread',2,1,?,2)")
        .run(JSON.stringify(broken))
      database.exec("UPDATE threads SET updated_seq = 2 WHERE id = 'thread'")
    },
  )

  await expect(f.persistence.submit([getDelta()])).rejects.toThrow("could not start")
  await f.persistence.ready

  expect(starts).toBe(4)
  expect(f.errors).toHaveLength(1)
  expect(f.published).toEqual([{ type: "transcript.resync" }])
  await expect(f.persistence.submit([getDelta("other")])).rejects.toThrow("could not start")
})

test("busy startup retries past the permanent startup failure limit", async () => {
  let blocker: SqliteDatabase | undefined
  let starts = 0
  let busyErrors = 0
  const f = await getFixture(
    () => {
      starts += 1
      const worker = createSourceWorker(streamPersistenceWorkerSource)
      worker.addEventListener("message", ({ data }) => {
        if (data.type !== "startup-error" || !data.busy) return
        busyErrors += 1
        if (busyErrors === 5) blocker?.exec("ROLLBACK")
      })
      return worker
    },
    (database) => {
      blocker = new SqliteDatabase(database.filename)
      blocker.exec("BEGIN IMMEDIATE")
      cleanups.add(() => blocker?.close())
    },
  )

  await f.persistence.ready
  const committed = await f.persistence.submit([getDelta()])

  expect(busyErrors).toBe(5)
  expect(starts).toBe(6)
  expect(committed.events).toHaveLength(1)
})

test("busy worker startup releases readiness after a bound and keeps retrying", async () => {
  let blocker: SqliteDatabase | undefined
  let starts = 0
  let busyErrors = 0
  let delayedReadiness = 0
  const f = await getFixture(
    () => {
      starts += 1
      const worker = createSourceWorker(streamPersistenceWorkerSource)
      worker.addEventListener("message", ({ data }) => {
        if (data.type === "startup-error" && data.busy) busyErrors += 1
      })
      return worker
    },
    (database) => {
      blocker = new SqliteDatabase(database.filename)
      blocker.exec("BEGIN IMMEDIATE")
      cleanups.add(() => blocker?.close())
    },
    100,
    () => {
      delayedReadiness += 1
    },
  )

  await f.persistence.ready

  expect(delayedReadiness).toBe(1)
  expect(busyErrors).toBeGreaterThan(0)
  expect(starts).toBeGreaterThan(0)
  blocker?.exec("ROLLBACK")
  const committed = await f.persistence.submit([getDelta()])

  expect(committed.events).toHaveLength(1)
})

test.each(["bytes", "events"] as const)(
  "worker downtime cannot grow buffered %s beyond admission limits",
  async (limit) => {
    const f = await getFixture(() => {
      throw new Error("Synthetic startup failure")
    })
    const event = getDelta("thread", limit === "bytes" ? "x".repeat(64 * 1024) : "x")
    const count = limit === "bytes" ? 140 : STREAM_PERSISTENCE_LIMITS.events + 1
    const writes = Array.from({ length: count }, () =>
      f.persistence.submit([event]).catch((error: Error) => error.message),
    )

    const results = await Promise.all(writes)

    const overflow = results.filter((result) => typeof result === "string" && result.includes("buffer limit"))
    expect(overflow.length).toBeGreaterThan(0)
    expect(results.filter((result) => result === "Stream persistence could not start").length).toBeLessThanOrEqual(
      STREAM_PERSISTENCE_LIMITS.events,
    )
    expect(f.errors).toHaveLength(1)
  },
)

test("the worker uses NORMAL, a bounded cache and no automatic checkpoints", async () => {
  const pragmas = Promise.withResolvers<{ synchronous: number; cache: number; autocheckpoint: number }>()
  const f = await getFixture(() => {
    const source = streamPersistenceWorkerSource.replace(
      'self.postMessage({ type: "ready" });',
      `
      self.postMessage({ type: "test-pragmas",
        synchronous: database.query("PRAGMA synchronous").get().synchronous,
        cache: database.query("PRAGMA cache_size").get().cache_size,
        autocheckpoint: database.query("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint });
      self.postMessage({ type: "ready" });`,
    )
    const worker = createSourceWorker(source)
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "test-pragmas") pragmas.resolve(data)
    })
    return worker
  })

  await f.persistence.ready
  const measured = await pragmas.promise

  expect(measured).toMatchObject({ synchronous: 1, cache: -65536, autocheckpoint: 0 })
})
