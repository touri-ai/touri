import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { createTranscriptRetention } from "../../src/kernel/transcript-retention"
import { init as initRuntime } from "../../src/runtime"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("retention keeps five streamed runs, concurrent history/work readers and Stop responsive", async () => {
  const fixture = await getFixture()
  const retention = createTranscriptRetention(fixture.database)
  cleanups.add(retention.dispose)
  const queries = spyOn(fixture.database, "query")
  cleanups.add(() => queries.mockRestore())
  const lags: number[] = []
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    lags.push(Math.max(0, now - previous - 5))
    previous = now
  }, 5)
  cleanups.add(() => clearInterval(timer))
  const beforePressure = await getIoPressure()
  const started = performance.now()
  const durations: Record<string, number[]> = { work: [], history: [], activity: [] }
  const finished = Promise.withResolvers<void>()
  const stream = setInterval(() => {
    fixture.turns.forEach((turn) => {
      if (!turn.signal.aborted) turn.onEvent({ type: "text_delta", itemId: "reply", delta: "x" })
    })
  }, 20)
  cleanups.add(() => clearInterval(stream))
  const readers = Object.entries({
    work: "/runs",
    history: "/threads/thread-0/messages",
    activity: "/workspace/activity",
  }).map(async ([key, path]) => {
    while (performance.now() - started < 3000) {
      const before = performance.now()
      const response = await fixture.request(path)
      await response.arrayBuffer()
      expect(response.status).toBe(200)
      durations[key]?.push(performance.now() - before)
    }
  })
  let batches = 0
  const maintenance = (async () => {
    while (performance.now() - started < 3000) {
      await retention.run()
      batches += 1
      await Bun.sleep(10)
    }
    finished.resolve()
  })()
  // Adding a socket exercises the formerly synchronous forced-retention entry point too.
  const replayBus = createEventBus(fixture.database, undefined, { deferRecovery: true })
  cleanups.add(replayBus.stop)
  replayBus.add({ readyState: 1, sendText: (payload) => payload.length })
  await fixture.getReady(() => batches >= 2 && performance.now() - started >= 2500)
  const stopStarted = performance.now()
  const canceled = await fixture.request(`/runs/${fixture.runIds[0]}/cancel`, "POST")
  await fixture.getReady(() => fixture.turns.find((turn) => turn.thread.id === "thread-0")?.signal.aborted === true)
  await canceled.arrayBuffer()
  const stopMs = performance.now() - stopStarted
  await Promise.all([maintenance, ...readers, finished.promise])
  clearInterval(stream)
  await fixture.kernel.services.use("store.api")?.flushWritesAsync?.()
  clearInterval(timer)
  const metrics = {
    runtime: Bun.version,
    windowMs: performance.now() - started,
    samplingMs: 5,
    samples: lags.length,
    syntheticEvents: 50000,
    databaseBytes: fixture.databaseBytes,
    walBytes: fixture.walBytes,
    activeRuns: 5,
    streamIntervalMs: 20,
    readers: 3,
    batches,
    timerLagMs: getPercentiles(lags),
    endpointMs: Object.fromEntries(Object.entries(durations).map(([key, values]) => [key, getPercentiles(values)])),
    stopMs,
    ioPressure: { before: beforePressure, after: await getIoPressure() },
  }
  console.info(`synthetic-retention ${JSON.stringify(metrics)}`)

  expect(lags.length).toBeGreaterThan(100)
  expect(metrics.timerLagMs.p99).toBeLessThan(50)
  expect(metrics.timerLagMs.max).toBeLessThan(400)
  expect(stopMs).toBeLessThan(1000)
  expect(canceled.status).toBe(200)
  expect(batches).toBeGreaterThan(2)
  expect(queries.mock.calls.filter(([sql]) => sql.includes("ORDER BY seq DESC LIMIT 1 OFFSET ?")).length).toBe(0)
  expect(queries.mock.calls.filter(([sql]) => /^DELETE FROM (ui_event_log|transcript_entries)/.test(sql)).length).toBe(
    0,
  )
  expect(fixture.database.query("SELECT count(*) AS n FROM ui_event_log").get()).not.toEqual({ n: 50000 })
  expect(fixture.database.query("SELECT status FROM runs WHERE id=?").get(fixture.runIds[0] ?? "")).toEqual({
    status: "canceled",
  })
  const replies = fixture.database.query("SELECT text FROM messages WHERE role='assistant'").all() as Array<{
    text: string
  }>
  expect(replies).toHaveLength(5)
  expect(replies.every(({ text }) => text.length > 0)).toBe(true)
  const history = (await (await fixture.request("/threads/thread-0/messages")).json()) as { messages: Message[] }
  const persisted = fixture.database
    .query("SELECT text FROM messages WHERE thread_id='thread-0' AND role='assistant'")
    .get() as { text: string }
  expect(history.messages.find(({ role }) => role === "assistant")?.text).toBe(persisted.text)
  const floor = Number(
    (fixture.database.query("SELECT value FROM schema_meta WHERE key='ui_event_floor_seq'").get() as { value: string })
      .value,
  )
  expect(floor).toBeGreaterThan(0)
  expect(replayBus.replay(floor - 1)[0]?.event.type).toBe("transcript.resync")
  const head = (
    fixture.database.query("SELECT seq FROM sqlite_sequence WHERE name='ui_event_log'").get() as { seq: number }
  ).seq
  expect(await replayBus.catchUp(head)).toEqual([])
  expect((await replayBus.catchUp(head - 1)).map(({ seq }) => seq)).toEqual([head])
}, 30_000)

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-retention-live-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  // Start with accumulated history so live delivery begins at its committed head.
  const seed = openDatabase({ filename: join(root, "touri.db") })
  seed
    .query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000)
    INSERT INTO ui_event_log(at,event_json) SELECT ?,? FROM n`)
    .run(Date.now(), JSON.stringify({ type: "fixture.event", text: "x".repeat(1024) }))
  seed.close()
  const runtime = createKernel({
    appData: root,
    web: {
      hostname: "127.0.0.1",
      port: getPort(),
      intercept: async ({ request }) =>
        request.headers.get("Authorization") === "Bearer synthetic-retention"
          ? null
          : new Response(null, { status: 401 }),
      host: () => async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "Synthetic host" }),
    },
  })
  cleanups.add(runtime.stop)
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database.exec(`INSERT INTO settings(key,value_json,updated_at) VALUES('maxConcurrentRuns','5',1)`)
  // Adapter calls are recorded only in this fixture-local collection.
  const turns: StartTurnArgs[] = []
  await initRuntime(runtime.kernel, undefined, {
    providerAdapters: {
      codex: {
        provider: "codex",
        detect: async () => ({ success: true, path: "/synthetic/provider", version: "1", loggedIn: true }),
        startTurn: async (args) => {
          turns.push(args)
          args.onEvent({ type: "turn_started", externalTurnId: "synthetic-turn" })
          await new Promise<void>((resolve) => {
            args.signal.addEventListener("abort", () => resolve(), { once: true })
            if (args.signal.aborted) resolve()
          })
          return { success: false, errorCode: "canceled", error: "Synthetic cancellation" }
        },
        answerApproval: async () => ({ success: true }),
        shutdown: async () => {},
      },
    },
  })
  cleanups.add(async () => {
    await runtime.kernel.services.use("runtime.shutdown")?.()
  })
  const runIds = Array.from({ length: 5 }, (_, index) => {
    database
      .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES(?,'Synthetic','codex',?,1,1)")
      .run(`bot-${index}`, root)
    database
      .query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES(?,?,'Synthetic',1,1)")
      .run(`thread-${index}`, `bot-${index}`)
    const store = runtime.kernel.services.use("store.api")
    const inserted = store?.insertMessage({
      message: {
        id: `request-${index}`,
        threadId: `thread-${index}`,
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Synthetic request",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!inserted?.success) throw new Error("Synthetic request failed")
    const run = runtime.kernel.services.use("runtime.enqueue")?.({
      threadId: `thread-${index}`,
      requestMessageId: inserted.message.id,
      trigger: "user",
    })
    if (!run?.success) throw new Error("Synthetic run failed")
    return run.run.id
  })
  const getReady = async (ready: () => boolean) => {
    const deadline = performance.now() + 10_000
    while (!ready()) {
      if (performance.now() > deadline) throw new Error("Synthetic operation did not finish")
      await Bun.sleep(5)
    }
  }
  await getReady(() => turns.length === 5)
  const databaseBytes = (await stat(database.filename)).size
  const walBytes = (await stat(`${database.filename}-wal`)).size
  const request = (path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: { Authorization: "Bearer synthetic-retention" },
      signal: AbortSignal.timeout(10_000),
    })

  return { kernel: runtime.kernel, database, turns, runIds, getReady, request, databaseBytes, walBytes }
}

const getPercentiles = (values: number[]) => {
  // Sort only this private sample copy; the input remains unchanged.
  const ordered = values.slice().sort((left, right) => left - right)
  return { count: values.length, p99: ordered[Math.ceil(ordered.length * 0.99) - 1] ?? 0, max: ordered.at(-1) ?? 0 }
}
const getIoPressure = async () => {
  const pressure = await readFile(join("/proc", "pressure", "io"), "utf8").catch(() => "")
  const full = pressure.match(/full avg10=([\d.]+).*total=(\d+)/)
  return full ? { fullAvg10: Number(full[1]), fullTotalUs: Number(full[2]) } : null
}
const getPort = (): number => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    try {
      const listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) })
      listener.stop(true)
      return port
    } catch {
      /* Try another free synthetic listener. */
    }
  }
  throw new Error("No synthetic port available")
}
