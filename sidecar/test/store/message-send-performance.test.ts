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
const THREAD_IDS = ["thread", "second", "third"] as const

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test.each(process.env.TOURI_MESSAGE_STRESS === "1" ? [1] : [1, 2, 3])(
  "%i active streams on large threads keep historical reads and streaming work bounded",
  async (streams) => {
    const threadIds = THREAD_IDS.slice(0, streams)
    const deltasPerBatch = process.env.TOURI_MESSAGE_STRESS === "1" ? 512 : 32
    const batchCount = process.env.TOURI_MESSAGE_STRESS === "1" ? 4 : 16
    const fixture = await getFixture(threadIds)
    const turns = new Map<string, StartTurnArgs>()
    const finishTurns = new Map<string, () => void>()
    const engine = createRuntimeEngine({
      kernel: fixture.kernel,
      runStage: fixture.stageTracker.run,
      environment: { PATH: "/usr/bin", HOME: fixture.root },
      providerAdapters: {
        codex: {
          provider: "codex",
          detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
          startTurn: async (args) => {
            if (turns.has(args.thread.id))
              return { success: true, externalSessionId: "fixture-followup", rolloutPath: null, status: "succeeded" }
            turns.set(args.thread.id, args)
            args.onEvent({ type: "turn_started", externalTurnId: args.thread.id })
            await new Promise<void>((resolve) => {
              finishTurns.set(args.thread.id, resolve)
              args.signal.addEventListener("abort", () => resolve(), { once: true })
            })
            return {
              success: true,
              externalSessionId: `fixture-session-${args.thread.id}`,
              rolloutPath: null,
              status: "succeeded",
            }
          },
          answerApproval: async () => ({ success: true }),
          shutdown: async () => {},
        },
      },
    })
    cleanups.add(() => engine.shutdown())
    fixture.kernel.services.provide("runtime.enqueue", engine.enqueue)
    await engine.ready
    for (const threadId of threadIds.slice(1)) await fixture.send(threadId, `initial-${threadId}`)
    await getReady(() => turns.size === streams - 1)
    const metrics = getQueryMetrics(fixture.database)
    cleanups.add(metrics.restore)
    const drift = getTimerDrift()
    cleanups.add(drift.stop)
    await Bun.sleep(10)

    const getSendTimings = async () => {
      const started = performance.now()
      const response = await fixture.send("thread", "initial-thread")
      const routeMs = performance.now() - started
      // Returning from the route is insufficient if queued work prevents the response from reaching I/O.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const sendMs = performance.now() - started
      await getReady(() => turns.size === streams)
      return { response, routeMs, sendMs, readyMs: performance.now() - started }
    }
    const { response, routeMs, sendMs, readyMs } = await traceSend(getSendTimings)
    await Bun.sleep(10)
    const sendReads = metrics.getMessageReads()
    const recoveryReads = metrics.getRecoveryReads()
    const sendMaxDelayMs = drift.getMax()
    const sendP99DelayMs = drift.getP99()
    const sendSamples = drift.getSamples()
    metrics.reset()
    drift.reset()
    fixture.stageTimings.reset()
    fixture.stageTracker.reset()
    const streamStarted = performance.now()
    const deltaWork: number[] = []
    for (let batch = 0; batch < batchCount; batch++) {
      fixture.stageTimings.measure("provider_event_dispatch", () => {
        for (const turn of turns.values()) {
          const before = fixture.stageTimings.getCalls("runtime_text_materialization")
          for (let delta = 0; delta < deltasPerBatch; delta++)
            turn.onEvent({ type: "text_delta", itemId: "reply", delta: "Resposta incremental. ".repeat(32) })
          deltaWork.push(fixture.stageTimings.getCalls("runtime_text_materialization") - before)
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
      })
      await fixture.stageTimings.measureAsync("transcript_journal_flush", () => fixture.store.flushWritesAsync?.())
      await Bun.sleep(1)
    }
    await Bun.sleep(10)
    const streamMaxDelayMs = drift.getMax()
    const streamP99DelayMs = drift.getP99()
    const streamSamples = drift.getSamples()
    const streamReads = metrics.getMessageReads()
    const streamReaders = metrics.getMessageReaders()
    const streamMs = Math.round(performance.now() - streamStarted)
    // Measure send responsiveness separately so the streaming window above has no request in flight.
    const busyStarted = performance.now()
    const busyResponse = await fixture.send("thread", "while-streaming")
    await new Promise<void>((resolve) => setImmediate(resolve))
    const busySendMs = performance.now() - busyStarted
    const busySendReads = metrics.getMessageReads() - streamReads
    for (const finish of finishTurns.values()) finish()
    await getReady(
      () =>
        (
          fixture.database
            .query("SELECT count(*) AS count FROM runs WHERE status IN ('starting', 'running')")
            .get() as {
            count: number
          }
        ).count === 0,
    )
    const stages = fixture.stageTracker.snapshot()
    const expectedBatchText = "Resposta incremental. ".repeat(32 * deltasPerBatch)
    const expectedText = `${Array.from({ length: batchCount }, () => expectedBatchText).join("\n\n")}\n\nConcluído.`
    const replies = threadIds.map(
      (threadId) =>
        (
          fixture.database
            .query(
              "SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant' AND length(text) > 10000 ORDER BY created_at DESC LIMIT 1",
            )
            .get(threadId) as { text: string } | null
        )?.text,
    )
    const measurements = {
      messagesPerThread: 2_000,
      toolCallsPerThread: 5_000,
      websocketClients: 2,
      deltasPerBatch,
      batchCount,
      streams: turns.size,
      routeMs: Math.round(routeMs * 10) / 10,
      sendMs: Math.round(sendMs * 10) / 10,
      readyMs: Math.round(readyMs * 10) / 10,
      streamMs,
      busySendMs: Math.round(busySendMs * 10) / 10,
      busySendReads,
      runtimeMaterializationsDuringDeltas: deltaWork.reduce((total, count) => total + count, 0),
      sendP99DelayMs: Math.round(sendP99DelayMs * 10) / 10,
      streamP99DelayMs: Math.round(streamP99DelayMs * 10) / 10,
      sendSamples,
      streamSamples,
      sendMaxDelayMs: Math.round(sendMaxDelayMs * 10) / 10,
      streamMaxDelayMs: Math.round(streamMaxDelayMs * 10) / 10,
      maxDelayMs: Math.round(Math.max(sendMaxDelayMs, streamMaxDelayMs) * 10) / 10,
      sendReads,
      recoveryReads,
      streamReads,
      streamReaders,
      queries: metrics.getSlowest(),
      stages,
    }
    console.info(`message-send-performance ${JSON.stringify(measurements)}`)

    expect(response.status).toBe(201)
    expect(busyResponse.status).toBe(201)
    expect(busySendReads).toBeLessThan(20)
    expect(turns.size).toBe(streams)
    expect(sendReads).toBeLessThan(100)
    expect(recoveryReads).toBe(0)
    expect(streamReads).toBeLessThan(20)
    expect(replies).toEqual(threadIds.map(() => expectedText))
    expect(deltaWork).toEqual(Array.from({ length: streams * batchCount }, () => 0))
  },
  120_000,
)

const getFixture = async (threadIds: ReadonlyArray<string>) => {
  const root = mkdtempSync(join(tmpdir(), "touri-message-performance-"))
  const runtime = getOfflineRuntime(root)
  cleanups.add(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  const database = runtime.kernel.db as Database
  seedHistory(database, root, threadIds)
  const stageTimings = getStageTimings()
  const stageTracker = {
    run: stageTimings.measure,
    snapshot: () => Object.entries(stageTimings.snapshot()).map(([stage, timing]) => ({ stage, ...timing })),
    reset: stageTimings.reset,
  }
  const bus = createEventBus(database, stageTracker.run)
  cleanups.add(bus.stop)
  const routes = new Map<string, RouteHandler>()
  const kernel: Kernel = {
    ...runtime.kernel,
    publish: (event) => stageTimings.measure("event_bus_publish", () => bus.publish(event)),
    subscribe: bus.subscribe,
    registerRoutes: (module) => {
      module.routes.forEach((route) => {
        routes.set(`${route.method} ${route.path}`, route.handler)
      })
    },
  }
  await initStore(kernel, stageTracker.run)
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
    stageTimings,
    stageTracker,
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

const seedHistory = (database: Database, root: string, threadIds: ReadonlyArray<string>): void => {
  database.transaction(() => {
    database
      .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','codex',?,1,1)")
      .run(root)
    database.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES
      ('thread','bot','Conversa',1,1), ('second','bot','Segunda conversa',1,1), ('third','bot','Terceira conversa',1,1)`)
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
      VALUES (?,?,?,?,'text','complete',?,?,?,?,?)`)
    threadIds.forEach((threadId) => {
      Array.from({ length: 2_000 }, (_, index) => index).forEach((index) => {
        const assistant = index % 2 === 1
        const runId = assistant ? `${threadId}-history-run-${index}` : null
        if (runId)
          persistence.saveRun({
            ...run,
            id: runId,
            threadId,
            requestMessageId: `${threadId}-history-${index - 1}`,
            replyMessageId: `${threadId}-history-${index}`,
          })
        const text = `Mensagem ${index}. ${"Contexto da tarefa. ".repeat(200)}`
        const parts = Array.from({ length: assistant ? 5 : 0 }, (_, tool) => ({
          type: "tool_call",
          callId: `${threadId}-call-${index}-${tool}`,
          tool: "fixture_tool",
          summary: "Resultado sintético",
          inputJson: "{}",
          outputJson: "resultado ".repeat(index % 100 === 1 ? 12_800 : 800),
          ok: true,
          resolution: "succeeded",
          resolvedAt: index,
        }))
        insert.run(
          `${threadId}-history-${index}`,
          threadId,
          index ? `${threadId}-history-${index - 1}` : null,
          assistant ? "assistant" : "user",
          runId,
          text,
          JSON.stringify(parts),
          index,
          index,
        )
        const indexed = database
          .query("INSERT INTO messages_fts(text,thread_id,message_id) VALUES (?,?,?)")
          .run(text, threadId, `${threadId}-history-${index}`)
        if (hasSearchLocators)
          database
            .query("INSERT INTO message_search_rows(thread_id,message_id,fts_rowid) VALUES (?,?,?)")
            .run(threadId, `${threadId}-history-${index}`, indexed.lastInsertRowid)
        parts.forEach((part) => {
          database
            .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution,resolved_at)
              VALUES (?,?,?,?,'succeeded',?)`)
            .run(runId, part.callId, threadId, JSON.stringify(part), index)
        })
      })
    })
    threadIds.forEach((threadId) => {
      database.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(`${threadId}-history-1999`, threadId)
    })
  })()
}

const getQueryMetrics = (database: Database) => {
  // Keep profiling state local to this fixture; restore the SQLite boundary after each test.
  let messageReads = 0
  let recoveryReads = 0
  const durations = new Map<string, number>()
  const messageReaders = new Map<string, number>()
  const getStatement = database.query.bind(database)
  const query = spyOn(database, "query").mockImplementation((sql: string) => {
    if (/SELECT \* FROM messages WHERE/.test(sql)) {
      messageReads++
      // Keep only function names: stack locations can contain private checkout paths.
      const reader = (new Error().stack ?? "")
        .split("\n")
        .flatMap((line) => {
          const name = line.match(/at ([A-Za-z][A-Za-z0-9_.]+) /)?.[1]
          return name ? [name] : []
        })
        .slice(0, 4)
        .join(" > ")
      messageReaders.set(reader, (messageReaders.get(reader) ?? 0) + 1)
    }
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
    getMessageReaders: () => Object.fromEntries(messageReaders),
    getSlowest: () =>
      [...durations]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([sql, ms]) => ({ sql, ms: Math.round(ms) })),
    reset: () => {
      messageReads = 0
      messageReaders.clear()
      durations.clear()
    },
    restore: () => query.mockRestore(),
  }
}

const getStageTimings = () => {
  const stages = new Map<string, { calls: number; totalMs: number; maxMs: number }>()

  return {
    measure: <T, Input = undefined>(stage: string, action: (input: Input) => T, input?: Input): T => {
      const startedAt = performance.now()
      try {
        return action(input as Input)
      } finally {
        const durationMs = performance.now() - startedAt
        const timing = stages.get(stage)
        if (timing) {
          timing.calls += 1
          timing.totalMs += durationMs
          timing.maxMs = Math.max(timing.maxMs, durationMs)
        } else stages.set(stage, { calls: 1, totalMs: durationMs, maxMs: durationMs })
      }
    },
    measureAsync: async <T>(stage: string, action: () => Promise<T> | undefined): Promise<T | undefined> => {
      const startedAt = performance.now()
      try {
        return await action()
      } finally {
        const durationMs = performance.now() - startedAt
        const timing = stages.get(stage)
        if (timing) {
          timing.calls += 1
          timing.totalMs += durationMs
          timing.maxMs = Math.max(timing.maxMs, durationMs)
        } else stages.set(stage, { calls: 1, totalMs: durationMs, maxMs: durationMs })
      }
    },
    getCalls: (stage: string) => stages.get(stage)?.calls ?? 0,
    snapshot: () =>
      Object.fromEntries(
        [...stages].map(([stage, values]) => [
          stage,
          {
            calls: values.calls,
            totalMs: Math.round(values.totalMs * 10) / 10,
            maxMs: Math.round(values.maxMs * 10) / 10,
          },
        ]),
      ),
    reset: () => stages.clear(),
  }
}

const getTimerDrift = () => {
  let previous = performance.now()
  let maximum = 0
  // Keep diagnostic mutation local and cap samples even if a failing fixture runs slowly.
  const samples: number[] = []
  const timer = setInterval(() => {
    const now = performance.now()
    const delay = Math.max(0, now - previous - 2)
    maximum = Math.max(maximum, delay)
    if (samples.length < 4_096) samples.push(delay)
    previous = now
  }, 2)

  return {
    getMax: () => maximum,
    getP99: () => {
      const ordered = samples.slice().sort((left, right) => left - right)
      return ordered[Math.max(0, Math.ceil(ordered.length * 0.99) - 1)] ?? 0
    },
    getSamples: () => samples.length,
    reset: () => {
      previous = performance.now()
      maximum = 0
      samples.length = 0
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
