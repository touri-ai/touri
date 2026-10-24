import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"
import { writeDatabaseAsync } from "../../src/kernel/database-write"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus, REPLAY_LIMITS } from "../../src/kernel/event-bus"
import { profileProviders } from "../../src/kernel/provider-profiles"
import type { TranscriptRef } from "../../src/kernel/transcript-events"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("a held live reference read leaves input and health responsive and preserves committed order", async () => {
  const fixture = await getFixture()
  const server = startProbeServer()
  const read = Promise.withResolvers<UiEvent[]>()
  const reading = Promise.withResolvers<void>()
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: async () => {
      reading.resolve()
      return read.promise
    },
  })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  fixture.saveReference()
  const queries = forbidReferenceReads(fixture.database)
  bus.publish(getMarker("after-reference"))
  await reading.promise

  const input = await (await fetch(`${server.url}input`)).text()
  const health = await (await fetch(`${server.url}healthz`)).json()
  const before = client.getFrames()
  read.resolve([getDelta()])
  await waitFor(() => client.getEvents().length === 2)

  expect(input).toBe("input-accepted")
  expect(health).toEqual({ ok: true })
  expect(before).toHaveLength(1)
  expect(client.getEvents().map(({ seq }) => seq)).toEqual([1, 2])
  expect(client.getEvents().map(({ event }) => event)).toEqual([getDelta(), getMarker("after-reference")])
  expect(queries.mock.calls.some(([sql]) => String(sql).includes("SELECT event_json FROM transcript_entries"))).toBe(
    false,
  )
})

test("committed control callbacks do not wait behind cold history while socket order stays intact", async () => {
  const fixture = await getFixture()
  const read = Promise.withResolvers<UiEvent[]>()
  const bus = createEventBus(fixture.database, undefined, { getReferenceEvents: () => read.promise })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  const local: UiEvent[] = []
  bus.subscribeRuntime(({ event }) => local.push(event))
  fixture.saveReference()
  const marker = getMarker("committed-control")

  bus.publish(marker)

  expect(local).toEqual([marker])
  expect(client.getFrames()).toHaveLength(1)
  read.resolve([getDelta()])
  await waitFor(() => client.getEvents().length === 2)
  expect(client.getEvents().map(({ event }) => event)).toEqual([getDelta(), marker])
  expect(local.filter((event) => event.type === "import.progress")).toEqual([marker])
})

test("a committed publisher hands off its payload and cancels a redundant reference read", async () => {
  const fixture = await getFixture()
  const read = Promise.withResolvers<UiEvent[]>()
  let signal: AbortSignal | undefined
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: (_references, caller) => {
      signal = caller
      return read.promise
    },
  })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  fixture.saveReference()
  forbidReferenceReads(fixture.database)

  bus.publish(getMarker("after-reference"))
  bus.publish(getDelta())
  const beforeLateReply = client.getEvents()
  read.resolve([getDelta("stale synthetic reply")])
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(signal?.aborted).toBe(true)
  expect(beforeLateReply.map(({ seq }) => seq)).toEqual([1, 2])
  expect(client.getEvents()).toEqual(beforeLateReply)
  expect(client.getEvents()[0]?.event).toEqual(getDelta())
})

test("queued live snapshots retain their exact revisions across a committed publication", async () => {
  const fixture = await getFixture()
  const bus = createEventBus(fixture.database)
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  const first = getSnapshot("first synthetic revision", 1)
  const second = getSnapshot("second synthetic revision", 2)
  fixture.database.transaction(() => bus.publish(getMarker("committed-prefix")))()
  forbidReferenceReads(fixture.database)

  fixture.saveReference("message.updated", 1)
  bus.publish(first)
  fixture.saveReference("message.updated", 2)
  bus.publish(second)
  await waitFor(() => client.getEvents().length === 3)

  expect(client.getEvents().map(({ seq }) => seq)).toEqual([1, 2, 3])
  expect(client.getEvents().map(({ event }) => event)).toEqual([getMarker("committed-prefix"), first, second])
})

test("an owned transaction hands off its committed snapshot before the writer resolves", async () => {
  const fixture = await getFixture()
  const read = Promise.withResolvers<UiEvent[]>()
  const bus = createEventBus(fixture.database, undefined, { getReferenceEvents: () => read.promise })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  const snapshot = getSnapshot("committed terminal reply", 1)
  forbidReferenceReads(fixture.database)

  await writeDatabaseAsync(fixture.database, () => {
    fixture.saveReference("message.updated", 1)
    bus.publish(snapshot)
    expect(client.getEvents()).toHaveLength(0)
  })

  expect(client.getEvents().map(({ event }) => event)).toEqual([snapshot])
})

test("a nested writer cannot publish before its outer transaction commits", async () => {
  const fixture = await getFixture()
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: async () => [getDelta("committed synthetic")],
  })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)

  await expect(
    writeDatabaseAsync(fixture.database, () => {
      void writeDatabaseAsync(fixture.database, () => {
        fixture.saveReference()
        bus.publish(getDelta("rolled-back nested"))
      })
      throw new Error("outer rollback")
    }),
  ).rejects.toThrow("outer rollback")
  fixture.saveReference()
  bus.publish(getMarker("committed-control"))
  await waitFor(() => client.getEvents().length === 2)

  expect(client.getEvents()[0]?.event).toEqual(getDelta("committed synthetic"))
  expect(JSON.stringify(client.getEvents())).not.toContain("rolled-back nested")
})

test("an owned transaction discards its handoff after rollback", async () => {
  const fixture = await getFixture()
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: async () => [getDelta("committed synthetic")],
  })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)

  await expect(
    writeDatabaseAsync(fixture.database, () => {
      fixture.saveReference()
      bus.publish(getDelta("rolled-back synthetic"))
      throw new Error("synthetic rollback")
    }),
  ).rejects.toThrow("synthetic rollback")
  fixture.saveReference()
  bus.publish(getMarker("after-rollback"))
  await waitFor(() => client.getEvents().length === 2)

  expect(client.getEvents()[0]?.event).toEqual(getDelta("committed synthetic"))
  expect(JSON.stringify(client.getEvents())).not.toContain("rolled-back synthetic")
})

test("a rolled-back publisher cannot supply the payload of a later committed reference", async () => {
  const fixture = await getFixture()
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: async () => [getDelta("committed synthetic")],
  })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  const rollback = fixture.database.transaction(() => {
    fixture.saveReference()
    bus.publish(getDelta("rolled-back synthetic"))
    throw new Error("synthetic rollback")
  })

  expect(rollback).toThrow("synthetic rollback")
  fixture.saveReference()
  bus.publish(getMarker("after-rollback"))
  await waitFor(() => client.getEvents().length === 2)

  expect(client.getEvents()[0]?.event).toEqual(getDelta("committed synthetic"))
  expect(JSON.stringify(client.getEvents())).not.toContain("rolled-back synthetic")
})

test("reconnect sends held replay before new live events and filters both paths", async () => {
  const fixture = await getFixture()
  fixture.saveMarker("seed")
  fixture.saveReference()
  const read = Promise.withResolvers<UiEvent[]>()
  const bus = createEventBus(fixture.database, undefined, { getReferenceEvents: () => read.promise })
  cleanups.add(() => bus.stop())
  const client = getClient()
  const visible = (event: UiEvent) => event.type !== "import.progress" || event.importId !== "private-synthetic"
  forbidReferenceReads(fixture.database)

  bus.add(client.socket, 1, visible)
  bus.publish(getMarker("private-synthetic"))
  bus.publish(getMarker("public-synthetic"))
  const before = client.getFrames()
  read.resolve([getDelta()])
  await waitFor(() => client.getEvents().length === 3)

  expect(before).toEqual([])
  expect(client.getEvents().map(({ seq }) => seq)).toEqual([2, 3, 4])
  expect(client.getEvents()[1]?.event).toEqual({ type: "transcript.superseded" })
  expect(JSON.stringify(client.getFrames())).not.toContain("private-synthetic")
})

test("visibility revoked during replay also redacts the buffered live suffix", async () => {
  const fixture = await getFixture()
  fixture.saveMarker("seed")
  fixture.saveReference()
  const read = Promise.withResolvers<UiEvent[]>()
  const bus = createEventBus(fixture.database, undefined, { getReferenceEvents: () => read.promise })
  cleanups.add(() => bus.stop())
  const client = getClient()
  let allowed = true

  bus.add(client.socket, 1, () => allowed)
  bus.publish(getMarker("revoked-synthetic"))
  allowed = false
  read.resolve([getDelta()])
  await waitFor(() => client.getEvents().length === 2)

  expect(client.getEvents().map(({ seq }) => seq)).toEqual([2, 3])
  expect(client.getEvents().every(({ event }) => event.type === "transcript.superseded")).toBe(true)
  expect(JSON.stringify(client.getFrames())).not.toContain("revoked-synthetic")
})

test("disconnect cancels its replay read and suppresses late delivery", async () => {
  const fixture = await getFixture()
  fixture.saveMarker("seed")
  fixture.saveReference()
  const read = Promise.withResolvers<UiEvent[]>()
  let signal: AbortSignal | undefined
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: (_references, caller) => {
      signal = caller
      return read.promise
    },
  })
  cleanups.add(() => bus.stop())
  const client = getClient()

  bus.add(client.socket, 1)
  bus.remove(client.socket)
  read.resolve([getDelta()])
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(signal?.aborted).toBe(true)
  expect(client.getFrames()).toEqual([])
})

test.each(["events", "bytes"])(
  "a replay buffer exceeding its %s cap resyncs once and resumes at that cursor",
  async (limit) => {
    const fixture = await getFixture()
    fixture.saveMarker("seed")
    fixture.saveReference()
    const read = Promise.withResolvers<UiEvent[]>()
    const bus = createEventBus(fixture.database, undefined, { getReferenceEvents: () => read.promise })
    cleanups.add(() => bus.stop())
    const client = getClient()
    bus.add(client.socket, 1)

    const count = limit === "events" ? REPLAY_LIMITS.events + 1 : 33
    const marker = limit === "events" ? getMarker("bounded") : getMarker("bounded", "x".repeat(64 * 1024))
    Array.from({ length: count }, () => bus.publish(marker))
    read.resolve([getDelta()])
    await waitFor(() => client.getFrames().length === 1)
    bus.publish(getMarker("tail"))

    expect(client.getFrames()[0]).toEqual({ type: "resync", lastSeq: count + 2 })
    expect(client.getEvents().map(({ seq }) => seq)).toEqual([count + 3])
  },
)

test("the real read process preserves compacted snapshot fallback and missing-delta resync", async () => {
  const fixture = await getFixture()
  fixture.saveMarker("seed")
  fixture.saveReference("message.updated")
  fixture.database
    .query(`INSERT INTO bots(id, name, provider, home_dir, created_at, updated_at)
    VALUES ('synthetic-bot', 'Synthetic', ?, '/synthetic', 1, 1)`)
    .run(profileProviders[0])
  fixture.database.exec(`INSERT INTO threads(id, bot_id, title, created_at, updated_at)
    VALUES ('synthetic-thread', 'synthetic-bot', 'Synthetic', 1, 1);
    INSERT INTO messages(id, thread_id, role, kind, status, text, parts_json, source, created_at, updated_at)
    VALUES ('synthetic-message', 'synthetic-thread', 'assistant', 'text', 'complete', 'synthetic snapshot', '[]', 'local', 1, 1);
    UPDATE transcript_maintenance SET delete_before_id = 100000 WHERE id = 1;
    DELETE FROM transcript_entries;
    UPDATE transcript_maintenance SET delete_before_id = 0 WHERE id = 1;`)
  const bus = createEventBus(fixture.database)
  cleanups.add(() => bus.stop())
  forbidReferenceReads(fixture.database)

  const snapshot = await bus.catchUp(1)
  fixture.saveReference()
  const missingDelta = await bus.catchUp(2)

  expect(snapshot[0]?.event).toMatchObject({ type: "message.updated", message: { text: "synthetic snapshot" } })
  expect(missingDelta).toMatchObject([{ seq: 3, event: { type: "transcript.resync" } }])
})

test("slow synthetic reference storage does not consume the live event-loop budget", async () => {
  const fixture = await getFixture()
  const server = startProbeServer()
  const databaseQuery = fixture.database.query.bind(fixture.database)
  const delayMs = 150
  const queries = spyOn(fixture.database, "query").mockImplementation((sql) => {
    if (sql.includes("SELECT event_json FROM transcript_entries"))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    return databaseQuery(sql)
  })
  cleanups.add(() => queries.mockRestore())
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      return [getDelta()]
    },
  })
  cleanups.add(() => bus.stop())
  fixture.saveReference()
  const started = performance.now()
  let deliveredAt = 0
  bus.subscribe(() => {
    deliveredAt = performance.now() - started
  })
  let samples: number[] = []
  const sampling = (async () => {
    for (const _index of Array.from({ length: 60 })) {
      const expected = performance.now() + 5
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      samples = samples.concat(Math.max(0, performance.now() - expected))
    }
  })()

  bus.publish(getMarker("latency"))
  const healthStarted = performance.now()
  const health = await (await fetch(`${server.url}healthz`)).json()
  const healthMs = performance.now() - healthStarted
  await sampling
  await waitFor(() => deliveredAt > 0)
  // Sort a fresh, bounded probe array; the recorded samples remain unchanged.
  const ordered = Array.from(samples).sort((left, right) => left - right)
  const p99Ms = ordered[Math.ceil(ordered.length * 0.99) - 1] ?? 0
  const maxMs = ordered.at(-1) ?? 0

  console.info(
    JSON.stringify({
      syntheticReference: {
        runtime: Bun.version,
        references: 1,
        delayMs,
        samples: samples.length,
        intervalMs: 5,
        p99Ms,
        maxMs,
        healthMs,
        deliveredAt,
      },
    }),
  )
  expect(health).toEqual({ ok: true })
  expect(p99Ms).toBeLessThan(50)
  expect(maxMs).toBeLessThan(500)
})

test("a failed live reader retries the same cursor and stop aborts the next in-flight read", async () => {
  const fixture = await getFixture()
  let attempts = 0
  let signal: AbortSignal | undefined
  const held = Promise.withResolvers<UiEvent[]>()
  const bus = createEventBus(fixture.database, undefined, {
    getReferenceEvents: async (_references, caller) => {
      attempts += 1
      signal = caller
      if (attempts === 1) throw new Error("synthetic read failure")
      if (attempts === 2) return [getDelta()]
      return held.promise
    },
  })
  cleanups.add(() => bus.stop())
  const client = getClient()
  bus.add(client.socket)
  fixture.saveReference()

  bus.publish(getMarker("retry"))
  await waitFor(() => client.getEvents().length === 2)
  fixture.saveReference()
  bus.publish(getMarker("stop"))
  await waitFor(() => attempts === 3)
  await bus.stop()
  held.resolve([getDelta()])
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(client.getEvents().map(({ seq }) => seq)).toEqual([1, 2])
  expect(signal?.aborted).toBe(true)
})

test("a real 32-reference batch keeps health responsive with bounded synthetic payloads", async () => {
  const fixture = await getFixture()
  const server = startProbeServer()
  const bus = createEventBus(fixture.database)
  cleanups.add(() => bus.stop())
  const delta = getDelta("x".repeat(64 * 1024))
  fixture.database
    .query("INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES (?, 1, 1, ?, 1)")
    .run("synthetic-thread", JSON.stringify(delta))
  fixture.database.exec(
    "UPDATE schema_meta SET value = (SELECT CAST(MAX(id) AS TEXT) FROM transcript_entries) WHERE key = 'transcript_event_checkpoint'",
  )
  Array.from({ length: 32 }, () => fixture.saveReference())
  const queryPlans = fixture.database
    .query("EXPLAIN QUERY PLAN SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
    .all("synthetic-thread", 1)
  forbidReferenceReads(fixture.database)
  const started = performance.now()
  let sequences: number[] = []
  bus.subscribe(({ seq }) => {
    sequences = sequences.concat(seq)
  })
  const samples: number[] = []
  const sampling = (async () => {
    for (const _index of Array.from({ length: 60 })) {
      const expected = performance.now() + 5
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      // This accumulator belongs only to the bounded latency probe.
      samples.push(Math.max(0, performance.now() - expected))
    }
  })()

  bus.publish(getMarker("real-batch"))
  const healthStarted = performance.now()
  const health = await (await fetch(`${server.url}healthz`)).json()
  const healthMs = performance.now() - healthStarted
  await waitFor(() => sequences.length === 33)
  const deliveryMs = performance.now() - started
  await sampling
  // Sort a fresh, bounded probe array; the recorded samples remain unchanged.
  const ordered = Array.from(samples).sort((left, right) => left - right)
  const p99Ms = ordered[Math.ceil(ordered.length * 0.99) - 1] ?? 0
  const maxMs = ordered.at(-1) ?? 0

  console.info(
    JSON.stringify({
      syntheticBatch: {
        runtime: Bun.version,
        references: 32,
        bytesPerReference: 64 * 1024,
        samples: samples.length,
        intervalMs: 5,
        p99Ms,
        maxMs,
        healthMs,
        deliveryMs,
      },
    }),
  )
  expect(health).toEqual({ ok: true })
  expect(sequences).toEqual(Array.from({ length: 33 }, (_, index) => index + 1))
  expect(p99Ms).toBeLessThan(50)
  expect(maxMs).toBeLessThan(500)
  expect(JSON.stringify(queryPlans)).toContain("SEARCH transcript_entries USING INDEX")
})

test("an oversized live reference batch resyncs and releases subsequent control events", async () => {
  const fixture = await getFixture()
  const bus = createEventBus(fixture.database)
  cleanups.add(() => bus.stop())
  const delta = getDelta("x".repeat(REPLAY_LIMITS.bytes))
  fixture.database
    .query("INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES (?, 1, 1, ?, 1)")
    .run("synthetic-thread", JSON.stringify(delta))
  fixture.database.exec(
    "UPDATE schema_meta SET value = (SELECT CAST(MAX(id) AS TEXT) FROM transcript_entries) WHERE key = 'transcript_event_checkpoint'",
  )
  Array.from({ length: 32 }, () => fixture.saveReference())
  let delivered: Array<{ seq: number; type: UiEvent["type"] }> = []
  bus.subscribe(({ seq, event }) => {
    delivered = delivered.concat({ seq, type: event.type })
  })

  bus.publish(getMarker("after-oversized-batch"))
  await waitFor(() => delivered.at(-1)?.type === "import.progress")

  expect(delivered.map(({ seq }) => seq)).toEqual(Array.from({ length: 33 }, (_, index) => index + 1))
  expect(delivered.slice(0, -1).every(({ type }) => type === "transcript.resync")).toBe(true)
})

const startProbeServer = () => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (request) =>
          new URL(request.url).pathname === "/healthz" ? Response.json({ ok: true }) : new Response("input-accepted"),
      })
      cleanups.add(() => server.stop(true))
      return server
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error
    }
  }
  throw new Error("No free synthetic test port")
}

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-async-reference-"))
  const database = openDatabase({ filename: join(root, "synthetic.db") })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const saveReference = (type: TranscriptRef["type"] = "message.delta", seq = 1) =>
    database
      .query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)")
      .run(
        Date.now(),
        JSON.stringify({ type, ref: true, threadId: "synthetic-thread", messageId: "synthetic-message", seq }),
      )
  const saveMarker = (id: string) =>
    database
      .query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)")
      .run(Date.now(), JSON.stringify(getMarker(id)))

  return { database, saveReference, saveMarker }
}

const forbidReferenceReads = (database: ReturnType<typeof openDatabase>) => {
  const query = database.query.bind(database)
  const queries = spyOn(database, "query").mockImplementation((sql) => {
    if (
      sql.includes("SELECT event_json FROM transcript_entries") ||
      sql.includes("SELECT payload FROM transcript_message_events")
    )
      throw new Error("Reference reads must run outside the live connection")
    return query(sql)
  })
  cleanups.add(() => queries.mockRestore())

  return queries
}

const getDelta = (delta = "synthetic"): UiEvent => ({
  type: "message.delta",
  threadId: "synthetic-thread",
  messageId: "synthetic-message",
  partIndex: 0,
  delta,
  updatedSeq: 1,
})
const getSnapshot = (text: string, updatedSeq: number): UiEvent => ({
  type: "message.updated",
  message: {
    id: "synthetic-message",
    threadId: "synthetic-thread",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "streaming",
    runId: null,
    text,
    parts: [],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: updatedSeq,
    updatedSeq,
  },
})
const getMarker = (importId: string, phase = "done"): Extract<UiEvent, { type: "import.progress" }> => ({
  type: "import.progress",
  importId,
  phase,
  done: 1,
  total: 1,
})
const getClient = () => {
  let frames: Array<UiEventEnvelope | { type: string; lastSeq: number }> = []

  return {
    socket: {
      readyState: 1 as const,
      sendText: (payload: string) => {
        frames = frames.concat(JSON.parse(payload))
        return payload.length
      },
    },
    getFrames: () => frames,
    getEvents: () => frames.filter((frame): frame is UiEventEnvelope => "event" in frame),
  }
}
const waitFor = async (done: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!done() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
  expect(done()).toBe(true)
}
