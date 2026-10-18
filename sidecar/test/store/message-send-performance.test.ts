import { profile } from "bun:jsc"
import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, RouteHandler, Run, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createEventBus } from "../../src/kernel/event-bus"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("sending with large history and two streams bounds historical message reads", async () => {
  const fixture = await getFixture()
  const turns = new Map<string, StartTurnArgs>()
  const engine = createRuntimeEngine({
    kernel: fixture.kernel,
    environment: { PATH: "/usr/bin", HOME: fixture.root },
    providerAdapters: {
      codex: {
        provider: "codex",
        detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
        startTurn: async (args) => {
          turns.set(args.thread.id, args)
          args.onEvent({ type: "turn_started", externalTurnId: args.thread.id })
          await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }))
          return { success: false, errorCode: "canceled", error: "Canceled" }
        },
        answerApproval: async () => ({ success: true }),
        shutdown: async () => {},
      },
    },
  })
  cleanups.add(() => engine.shutdown())
  fixture.kernel.services.provide("runtime.enqueue", engine.enqueue)
  await fixture.send("second", "initial-second")
  await getReady(() => turns.has("second"))
  const metrics = getQueryMetrics(fixture.database)
  cleanups.add(metrics.restore)
  const drift = getTimerDrift()
  cleanups.add(drift.stop)
  await Bun.sleep(10)

  const getSendTimings = async () => {
    const started = performance.now()
    const response = await fixture.send("thread", "initial-large")
    const sendMs = performance.now() - started
    await getReady(() => turns.has("thread"))
    return { response, sendMs, readyMs: performance.now() - started }
  }
  const { response, sendMs, readyMs } = await traceSend(getSendTimings)
  await Bun.sleep(10)
  const sendReads = metrics.getMessageReads()
  const recoveryReads = metrics.getRecoveryReads()
  const sendMaxDelayMs = drift.getMax()
  metrics.reset()
  drift.reset()
  const streamStarted = performance.now()
  const busySends: number[] = []
  for (let batch = 0; batch < 16; batch++) {
    for (const turn of turns.values()) {
      for (let delta = 0; delta < 32; delta++)
        turn.onEvent({ type: "text_delta", itemId: "reply", delta: "Resposta incremental. ".repeat(32) })
      turn.onEvent({
        type: "item",
        part: {
          type: "tool_call",
          callId: `stream-${batch}`,
          tool: "fixture_tool",
          summary: "Resultado sintético",
          inputJson: "{}",
          outputJson: "Resultado da ferramenta.\n".repeat(1_000),
          ok: true,
        },
      })
    }
    if (batch === 8) {
      const started = performance.now()
      expect((await fixture.send("thread", "while-streaming")).status).toBe(201)
      busySends.push(performance.now() - started)
    }
    fixture.store.flushWrites?.()
    await Bun.sleep(1)
  }
  await Bun.sleep(10)
  const measurements = {
    messages: 2_000,
    toolCalls: 5_000,
    streams: turns.size,
    sendMs: Math.round(sendMs * 10) / 10,
    busySendMs: Math.round((busySends[0] ?? 0) * 10) / 10,
    readyMs: Math.round(readyMs * 10) / 10,
    streamMs: Math.round(performance.now() - streamStarted),
    sendMaxDelayMs: Math.round(sendMaxDelayMs * 10) / 10,
    streamMaxDelayMs: Math.round(drift.getMax() * 10) / 10,
    maxDelayMs: Math.round(Math.max(sendMaxDelayMs, drift.getMax()) * 10) / 10,
    sendReads,
    recoveryReads,
    streamReads: metrics.getMessageReads(),
    queries: metrics.getSlowest(),
  }
  console.info(`message-send-performance ${JSON.stringify(measurements)}`)

  expect(response.status).toBe(201)
  expect(turns.size).toBe(2)
  expect(sendReads).toBeLessThan(100)
  expect(recoveryReads).toBe(0)
  expect(measurements.streamReads).toBeLessThan(20)
}, 60_000)

const getFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-message-performance-"))
  const runtime = getOfflineRuntime(root)
  cleanups.add(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  const database = runtime.kernel.db as Database
  seedHistory(database, root)
  const bus = createEventBus(database)
  cleanups.add(bus.stop)
  const routes = new Map<string, RouteHandler>()
  const kernel: Kernel = {
    ...runtime.kernel,
    publish: bus.publish,
    subscribe: bus.subscribe,
    registerRoutes: (module) => {
      module.routes.forEach((route) => {
        routes.set(`${route.method} ${route.path}`, route.handler)
      })
    },
  }
  await initStore(kernel)
  bus.publish({ type: "transcript.resync" })
  // Exercise real socket serialization without a network listener or provider.
  const socket = () => ({ readyState: 1 as const, sendText: (payload: string) => payload.length })
  bus.add(socket())
  bus.add(socket())
  const store = kernel.services.use("store.api")
  const route = routes.get("POST /threads/:id/messages")
  if (!store || !route) throw new Error("Store route missing")

  return {
    kernel,
    root,
    database,
    store,
    send: (threadId: string, nonce: string) =>
      route({
        params: { id: threadId },
        query: {},
        body: {
          text: "Continue a tarefa.",
          parentId: store.getThread({ threadId })?.activeLeafId ?? null,
          attachmentIds: [],
          clientNonce: nonce,
        },
        signal: new AbortController().signal,
      }),
  }
}

const getOfflineRuntime = (root: string) => {
  const serve = spyOn(Bun, "serve").mockReturnValue({ port: 0, stop: () => {} } as ReturnType<typeof Bun.serve>)
  try {
    return createKernel({ appData: root })
  } finally {
    serve.mockRestore()
  }
}

const seedHistory = (database: Database, root: string): void => {
  database.transaction(() => {
    database
      .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','codex',?,1,1)")
      .run(root)
    database.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES
      ('thread','bot','Conversa',1,1), ('second','bot','Segunda conversa',1,1)`)
    const persistence = createRuntimePersistence({ database })
    const hasSearchLocators = !!database.query("SELECT 1 FROM sqlite_schema WHERE name = 'message_search_rows'").get()
    const run: Run = {
      id: "history-run",
      botId: "bot",
      threadId: "thread",
      provider: "codex",
      trigger: "user",
      requestMessageId: "history-0",
      replyMessageId: "history-1999",
      externalTurnId: null,
      status: "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: 1,
      startedAt: 1,
      finishedAt: 2,
    }
    const insert = database.query(`INSERT INTO messages
      (id,thread_id,parent_id,role,kind,status,run_id,text,parts_json,created_at,updated_at)
      VALUES (?,'thread',?,?,'text','complete',?,?,?,?,?)`)
    Array.from({ length: 2_000 }, (_, index) => index).forEach((index) => {
      const assistant = index % 2 === 1
      const runId = assistant ? `history-run-${index}` : null
      if (runId)
        persistence.saveRun({
          ...run,
          id: runId,
          requestMessageId: `history-${index - 1}`,
          replyMessageId: `history-${index}`,
        })
      const text = `Mensagem ${index}. ${"Contexto da tarefa. ".repeat(200)}`
      const parts = Array.from({ length: assistant ? 5 : 0 }, (_, tool) => ({
        type: "tool_call",
        callId: `call-${index}-${tool}`,
        tool: "fixture_tool",
        summary: "Resultado sintético",
        inputJson: "{}",
        outputJson: "resultado ".repeat(index % 100 === 1 ? 12_800 : 800),
        ok: true,
        resolution: "succeeded",
        resolvedAt: index,
      }))
      insert.run(
        `history-${index}`,
        index ? `history-${index - 1}` : null,
        assistant ? "assistant" : "user",
        runId,
        text,
        JSON.stringify(parts),
        index,
        index,
      )
      const indexed = database
        .query("INSERT INTO messages_fts(text,thread_id,message_id) VALUES (?,'thread',?)")
        .run(text, `history-${index}`)
      if (hasSearchLocators)
        database
          .query("INSERT INTO message_search_rows(thread_id,message_id,fts_rowid) VALUES ('thread',?,?)")
          .run(`history-${index}`, indexed.lastInsertRowid)
      parts.forEach((part) => {
        database
          .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution,resolved_at)
            VALUES (?,?,'thread',?,'succeeded',?)`)
          .run(runId, part.callId, JSON.stringify(part), index)
      })
    })
    database.exec("UPDATE threads SET active_leaf_id = 'history-1999' WHERE id = 'thread'")
  })()
}

const getQueryMetrics = (database: Database) => {
  // Keep profiling state local to this fixture; restore the SQLite boundary after each test.
  let messageReads = 0
  let recoveryReads = 0
  const durations = new Map<string, number>()
  const getStatement = database.query.bind(database)
  const query = spyOn(database, "query").mockImplementation((sql: string) => {
    if (/SELECT \* FROM messages WHERE/.test(sql)) messageReads++
    if (/SELECT resolution, resolved_at, part_json FROM tool_resolutions/.test(sql)) recoveryReads++
    return new Proxy(getStatement(sql), {
      get: (statement, property) => {
        const value = Reflect.get(statement, property)
        if (!["get", "all", "run"].includes(String(property)) || typeof value !== "function") return value
        return (...bindings: unknown[]) => {
          const started = performance.now()
          const result = Reflect.apply(value, statement, bindings)
          durations.set(sql, (durations.get(sql) ?? 0) + performance.now() - started)
          return result
        }
      },
    })
  })

  return {
    getMessageReads: () => messageReads,
    getRecoveryReads: () => recoveryReads,
    getSlowest: () =>
      [...durations]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([sql, ms]) => ({ sql, ms: Math.round(ms) })),
    reset: () => {
      messageReads = 0
      durations.clear()
    },
    restore: () => query.mockRestore(),
  }
}

const getTimerDrift = () => {
  let previous = performance.now()
  let maximum = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maximum = Math.max(maximum, now - previous - 2)
    previous = now
  }, 2)

  return {
    getMax: () => maximum,
    reset: () => {
      previous = performance.now()
      maximum = 0
    },
    stop: () => clearInterval(timer),
  }
}

const getReady = async (ready: () => boolean): Promise<void> => {
  const deadline = performance.now() + 20_000
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("Fixture provider did not start")
    await Bun.sleep(2)
  }
}

const traceSend = async <T>(action: () => Promise<T>): Promise<T> => {
  if (process.env.TOURI_MESSAGE_PROFILE !== "1") return action()
  // The optional profiler captures only startup, excluding fixture seeding and streaming.
  let result: T | undefined
  const sampled = await profile(async () => {
    result = await action()
  })
  console.info(sampled.functions)
  if (result === undefined) throw new Error("Missing profiled result")
  return result
}
