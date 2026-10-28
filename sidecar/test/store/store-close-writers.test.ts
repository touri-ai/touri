import { Database } from "bun:sqlite"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { Kernel, UiEvent, VmRuntime } from "@touri/contracts"
import { createAuthWriter } from "../../src/cli/auth/auth-writer"
import { createBackgroundTask, yieldBackground } from "../../src/kernel/background-task"
import { createStorageMaintenance } from "../../src/kernel/data-maintenance"
import { createEventBus } from "../../src/kernel/event-bus"
import { createEventLogWriter } from "../../src/kernel/event-log-writer"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { createTranscriptRetention } from "../../src/kernel/transcript-retention"
import { createWalCheckpointer } from "../../src/kernel/wal-checkpointer"
import { createBotEditQueue, createBotMetadataWriter } from "../../src/store/bot-metadata"
import { createStreamPersistence } from "../../src/store/stream-persistence"
import { createBotDeletionManager } from "../../src/vm/delete-bot"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const getFixture = () => {
  const fixture = testKernel()
  cleanups.add(fixture.close)
  return Object.assign({}, fixture, { root: fixture.kernel.paths.appData })
}
const getEvent = (): UiEvent => ({ type: "import.progress", importId: "synthetic", phase: "done", done: 1, total: 1 })

const seedBot = (database: Database): void => {
  database
    .query(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic',? ,'.',1,1)`)
    .run(profileProviders[0])
}

// This fake separates an acknowledged stop from the asynchronous release of the worker's connection.
const getHeldWorker = () => {
  const events = new EventTarget()
  const worker = Object.assign(events, {
    onmessage: null as Worker["onmessage"],
    onerror: null as Worker["onerror"],
    onmessageerror: null as Worker["onmessageerror"],
    ref: () => {},
    unref: () => {},
    terminate: mock(() => {}),
    postMessage: ({ type }: { type: string }) => {
      const reply = new MessageEvent("message", { data: { type: type === "start" ? "ready" : "stopped" } })
      queueMicrotask(() => {
        worker.onmessage?.call(worker as Worker, reply)
        events.dispatchEvent(reply)
      })
    },
  })
  const exit = () => events.dispatchEvent(new Event("close"))
  cleanups.add(() => {
    exit()
  })

  return { worker: worker as Worker, exit }
}

const workerKinds = ["checkpoint", "stream", "authentication"] as const
workerKinds.forEach((kind) => {
  test(`store close awaits ${kind} worker exit after the stop acknowledgement`, async () => {
    const fixture = getFixture()
    const held = getHeldWorker()
    const closed = mock(() => {})
    const close = await getWorkerCloser(kind, fixture, held.worker)

    const stopping = close().then(closed)
    await yieldBackground()
    const closedBeforeExit = closed.mock.calls.length
    held.exit()
    await stopping
    fixture.db.exec("PRAGMA query_only = ON")

    expect(closedBeforeExit).toBe(0)
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

const getWorkerCloser = async (
  kind: (typeof workerKinds)[number],
  fixture: ReturnType<typeof getFixture>,
  worker: Worker,
): Promise<() => Promise<void>> => {
  if (kind === "authentication") {
    const writer = await createAuthWriter(fixture.db.filename, () => worker)
    return writer.close
  }
  if (kind === "stream") {
    const writer = createStreamPersistence({
      database: fixture.db,
      appData: fixture.root,
      publish: () => {},
      onError: () => {},
      createWorker: () => worker,
    })
    await writer.ready
    return writer.close
  }
  const ready = Promise.withResolvers<void>()
  const writer = createWalCheckpointer({
    database: fixture.db,
    onReady: ready.resolve,
    onError: () => {},
    createWorker: () => worker,
  })
  await ready.promise
  return () => writer.dispose({ closing: true })
}

test("store close drains a contended event insert and refuses new admissions", async () => {
  const fixture = getFixture()
  const blocker = new Database(fixture.db.filename)
  cleanups.add(() => blocker.close())
  const saved = mock(() => {})
  const writer = createEventLogWriter(fixture.db, saved)
  blocker.exec("BEGIN IMMEDIATE")
  writer.save(getEvent())
  const closed = mock(() => {})

  const stopping = writer.close().then(closed)
  await yieldBackground()
  expect(closed).not.toHaveBeenCalled()
  blocker.exec("ROLLBACK")
  await stopping

  expect(saved).toHaveBeenCalledTimes(1)
  expect(() => writer.save(getEvent())).toThrow("EVENT_PERSISTENCE_CLOSED")
  expect(fixture.db.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 1 })
})

test("a background event insert rejected by a closed connection is logged and contained", async () => {
  const fixture = getFixture()
  const blocker = new Database(fixture.db.filename)
  cleanups.add(() => blocker.close())
  const log = mock(() => {})
  const writer = createEventLogWriter(fixture.db, () => {}, log)
  blocker.exec("BEGIN IMMEDIATE")
  writer.save(getEvent())

  fixture.db.close()
  blocker.exec("ROLLBACK")
  await expect(writer.flushAsync()).rejects.toThrow("EVENT_PERSISTENCE_FAILED")

  expect(log).toHaveBeenCalledTimes(1)
})

test("a scheduled event delivery contains a lost SQLite connection and logs no raw diagnostics", async () => {
  const fixture = getFixture()
  let continuation: (() => void) | undefined
  const log = mock<Kernel["log"]>(() => {})
  const bus = createEventBus(fixture.db, undefined, {
    log,
    schedule: (action) => {
      continuation = action
      return () => {
        continuation = undefined
      }
    },
  })
  cleanups.add(() => bus.stop())
  const insert = fixture.db.query("INSERT INTO ui_event_log(at,event_json) VALUES (1,?)")
  Array.from({ length: 40 }).forEach(() => {
    insert.run(JSON.stringify(getEvent()))
  })
  bus.publish(getEvent())
  const flush = continuation
  if (!flush) throw new Error("Missing delivery continuation")
  const query = spyOn(fixture.db, "query").mockImplementation(() => {
    throw Object.assign(new Error("synthetic private storage diagnostic"), { code: "SQLITE_IOERR" })
  })
  cleanups.add(() => query.mockRestore())

  expect(flush).not.toThrow()
  await bus.stop()

  expect(log).toHaveBeenCalled()
  expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic private storage diagnostic")
})

test("store close cancels scheduled delivery before the connection closes", async () => {
  const fixture = getFixture()
  let continuation: (() => void) | undefined
  const bus = createEventBus(fixture.db, undefined, {
    schedule: (action) => {
      continuation = action
      return () => {}
    },
  })
  const insert = fixture.db.query("INSERT INTO ui_event_log(at,event_json) VALUES (1,?)")
  Array.from({ length: 40 }).forEach(() => {
    insert.run(JSON.stringify(getEvent()))
  })
  bus.publish(getEvent())
  const flush = continuation
  if (!flush) throw new Error("Missing delivery continuation")

  await bus.stop()
  fixture.db.close()

  expect(flush).not.toThrow()
})

test("a transient delivery read failure preserves later publications and resumes its durable cursor", async () => {
  const fixture = getFixture()
  let continuation: (() => void) | undefined
  const log = mock<Kernel["log"]>(() => {})
  const bus = createEventBus(fixture.db, undefined, {
    log,
    schedule: (action) => {
      continuation = action
      const timer = setImmediate(action)
      return () => clearImmediate(timer)
    },
  })
  cleanups.add(() => bus.stop())
  const delivered = mock(() => {})
  bus.subscribe(delivered)
  const insert = fixture.db.query("INSERT INTO ui_event_log(at,event_json) VALUES (1,?)")
  Array.from({ length: 40 }).forEach(() => {
    insert.run(JSON.stringify(getEvent()))
  })
  bus.publish(getEvent())
  const flush = continuation
  if (!flush) throw new Error("Missing delivery continuation")
  const query = spyOn(fixture.db, "query").mockImplementation(() => {
    throw Object.assign(new Error("synthetic private storage diagnostic"), { code: "SQLITE_IOERR" })
  })
  cleanups.add(() => query.mockRestore())

  flush()
  query.mockRestore()
  bus.publish(getEvent())
  await bus.flushAsync()

  expect(fixture.db.query("SELECT count(*) AS count FROM ui_event_log").get()).toEqual({ count: 42 })
  expect(delivered).toHaveBeenCalledTimes(42)
  expect(log).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic private storage diagnostic")
})

test("store close awaits bot deletion suspended in host cancellation and preserves its job", async () => {
  const fixture = getFixture()
  seedBot(fixture.db)
  fixture.db.exec(
    "INSERT INTO bot_deletions(bot_id,delete_volumes,phase,created_at,updated_at) VALUES ('bot',0,'stopping',1,1)",
  )
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  fixture.kernel.services.provide("runtime.cancelBotTurns", async () => {
    started.resolve()
    await release.promise
  })
  const runtime = { destroy: mock(async () => {}) } as Pick<VmRuntime, "destroy">
  const logins = mock<Kernel["callHost"]>(async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "synthetic",
  }))
  const kernel = Object.assign({}, fixture.kernel, { callHost: logins })
  const manager = createBotDeletionManager(kernel, runtime as VmRuntime, async () => 0)
  manager.start("bot")
  await started.promise
  const closed = mock(() => {})

  const stopping = manager.dispose().then(closed)
  await yieldBackground()
  const closedBeforeRelease = closed.mock.calls.length
  fixture.db.exec("PRAGMA query_only = ON")
  release.resolve()
  await stopping

  expect(closedBeforeRelease).toBe(0)
  expect(logins).not.toHaveBeenCalled()
  expect(fixture.db.query("SELECT phase,error_code FROM bot_deletions").get()).toEqual({
    phase: "stopping",
    error_code: null,
  })
})

test("store close awaits maintenance collection and the session-key retry already in flight", async () => {
  const fixture = getFixture()
  fixture.db.exec(`INSERT INTO settings(key,value_json,updated_at)
    VALUES ('storage.deleted-attachments:synthetic','[]',1)`)
  const collection = Promise.withResolvers<void>()
  const retry = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  const maintenance = createStorageMaintenance({
    database: fixture.db,
    appData: fixture.root,
    publishResync: () => {},
    onError: () => {},
    createCheckpointer: () => ({ dispose: async () => {}, vacuum: async () => {} }),
    yieldBatch: async () => {
      collection.resolve()
      await release.promise
    },
    retryDeletedBrowserSessionKeys: async () => {
      retry.resolve()
      await release.promise
    },
  })
  await Promise.all([collection.promise, retry.promise])
  const closed = mock(() => {})

  const stopping = maintenance.dispose({ closing: true }).then(closed)
  await yieldBackground()
  const closedBeforeRelease = closed.mock.calls.length
  fixture.db.exec("PRAGMA query_only = ON")
  release.resolve()
  await stopping

  expect(closedBeforeRelease).toBe(0)
  expect(maintenance.snapshot().error).toBeUndefined()
})

test("store close awaits retention discovery before its helper can be created", async () => {
  const fixture = getFixture()
  const retention = createTranscriptRetention(fixture.db)
  const closed = mock(() => {})
  const running = retention.run()
  const settled = mock(() => {})
  void running.then(settled)

  await retention.dispose().then(closed)
  const settledAtClose = settled.mock.calls.length
  await running
  fixture.db.close()

  expect(settledAtClose).toBe(1)
  expect(closed).toHaveBeenCalledTimes(1)
  expect(await retention.run()).toBe(false)
})

test("store close awaits an admitted periodic pass and prevents another pass", async () => {
  const fixture = getFixture()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  const action = mock(async () => {
    await release.promise
    fixture.db.query("SELECT 1").get()
  })
  const task = createBackgroundTask("import_staging_expiry", action)
  const running = task.run()
  const closed = mock(() => {})

  const stopping = task.dispose().then(closed)
  await yieldBackground()
  const closedBeforeRelease = closed.mock.calls.length
  release.resolve()
  await stopping
  await running
  fixture.db.close()
  await task.run()

  expect(closedBeforeRelease).toBe(0)
  expect(action).toHaveBeenCalledTimes(1)
})

test("store close awaits metadata helpers and their acknowledgement recovery", async () => {
  const fixture = getFixture()
  seedBot(fixture.db)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  const writer = createBotMetadataWriter(fixture.db.filename, async () => {
    started.resolve()
    await release.promise
  })
  const select = "SELECT id,name FROM bots WHERE id = ?"
  const saving = writer
    .save(
      {
        botId: "bot",
        select,
        expected: { id: "bot", name: "Synthetic" },
        statement: { sql: "UPDATE bots SET name = ? WHERE id = ?", bindings: ["Updated", "bot"] },
      },
      new AbortController().signal,
    )
    .catch(() => undefined)
  await started.promise
  const closed = mock(() => {})

  const stopping = writer.dispose().then(closed)
  await yieldBackground()
  const closedBeforeRelease = closed.mock.calls.length
  release.resolve()
  await stopping
  await saving
  fixture.db.close()

  expect(closedBeforeRelease).toBe(0)
  expect(closed).toHaveBeenCalledTimes(1)
})

test("store close cancels queued bot edits and awaits the admitted edit", async () => {
  const fixture = getFixture()
  const queue = createBotEditQueue()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  const input = { botId: "bot", instructionBytes: 0, signal: new AbortController().signal }
  const active = queue.run(input, async () => {
    started.resolve()
    await release.promise
    fixture.db.query("SELECT 1").get()
  })
  const next = mock(async () => {})
  const queued = queue.run(input, next).catch(() => undefined)
  await started.promise
  const closed = mock(() => {})

  const stopping = queue.dispose().then(closed)
  await yieldBackground()
  const closedBeforeRelease = closed.mock.calls.length
  release.resolve()
  await stopping
  await Promise.all([active, queued])
  fixture.db.close()

  expect(closedBeforeRelease).toBe(0)
  expect(next).not.toHaveBeenCalled()
})
