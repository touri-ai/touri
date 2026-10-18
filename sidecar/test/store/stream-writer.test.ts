import { type Database, Database as SqliteDatabase } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { OUTPUT_INLINE_BUDGET_BYTES } from "../../src/kernel/output-blobs"
import type { PerformanceStageRunner } from "../../src/kernel/performance"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { compactTranscript, materializeTranscript } from "../../src/kernel/transcript-storage"
import { init as initStore } from "../../src/store"
import { STREAM_WRITE_LIMITS } from "../../src/store/stream-writer"
import { readWorkspaceActivity } from "../../src/store/workspace-activity"

const MAX_STREAM_EVENTS_PER_WRITE = STREAM_WRITE_LIMITS.batchEvents

const fixture = async (runStage?: PerformanceStageRunner) => {
  const root = mkdtempSync(join(tmpdir(), "touri-stream-writer-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel, runStage)
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste',?,'/tmp',1,1)")
    .run(profileProviders[0])
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  for (const id of ["a", "b"])
    store.insertMessage({
      message: {
        id,
        threadId: "t",
        parentId: null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: null,
        text: "",
        parts: [{ type: "text", text: "" }],
        sender: null,
        source: "local",
      },
    })
  const events: UiEventEnvelope[] = []
  runtime.kernel.subscribe((event) => events.push(event))
  return {
    root,
    runtime,
    database,
    store,
    events,
    close: () => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test("projection validation scales with journal batches rather than provider deltas", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  const query = spyOn(f.database, "query")
  cleanups.add(() => query.mockRestore())

  Array.from({ length: 1_000 }, () => f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "x" }))
  f.store.flushWrites?.()
  const validations = query.mock.calls.filter(([sql]) =>
    sql.includes("SELECT updated_seq, generation, status FROM messages"),
  )
  const message = f.store.activePath({ threadId: "t", leafId: "a" })[0]

  expect(validations.length).toBeLessThanOrEqual(2)
  expect(message?.text).toBe("x".repeat(1_000))
})

test("a shared transcript checkpoint does not reload covered live projections", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "a" })
  f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: "b" })
  f.store.flushWrites?.()
  materializeTranscript(f.database)
  const query = spyOn(f.database, "query")
  cleanups.add(() => query.mockRestore())

  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: " depois" })
  f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: " depois" })
  f.store.flushWrites?.()
  const reads = query.mock.calls.filter(([sql]) => sql.includes("SELECT * FROM messages WHERE"))

  expect(reads).toHaveLength(0)
  expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe("a depois")
  expect(f.store.activePath({ threadId: "t", leafId: "b" })[0]?.text).toBe("b depois")
})

test("coalesces active messages in one timed flush and publishes only durable references", async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 20; index++)
      for (const messageId of ["a", "b"]) f.store.appendDelta({ threadId: "t", messageId, partIndex: 0, delta: "olá" })
    expect(f.events).toEqual([])
    expect(f.database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 2 })
    await Bun.sleep(STREAM_WRITE_LIMITS.delayMs + 30)
    const deltas = f.events.filter(({ event }) => event.type === "message.delta")
    expect(deltas).toHaveLength(2)
    expect(deltas.map(({ event }) => (event.type === "message.delta" ? event.delta : ""))).toEqual([
      "olá".repeat(20),
      "olá".repeat(20),
    ])
    const pointers = f.database
      .query("SELECT event_json FROM ui_event_log WHERE json_extract(event_json, '$.type') = 'message.delta'")
      .all() as { event_json: string }[]
    expect(pointers).toHaveLength(2)
    expect(pointers.every(({ event_json }) => JSON.parse(event_json).ref && !event_json.includes("olá"))).toBe(true)
  } finally {
    f.close()
  }
})

test("shutdown drains accepted text and can be repeated after the database closes", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Preservar" })
    expect(() => f.runtime.stop()).not.toThrow()
    expect(() => f.runtime.stop()).not.toThrow()
    const recovered = openDatabase({ filename: join(f.root, "touri.db") })
    try {
      materializeTranscript(recovered)
      expect(recovered.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Preservar" })
    } finally {
      recovered.close()
    }
  } finally {
    f.close()
  }
})

test("part-only recovery uses the dirty queue and keeps workspace approvals current before checkpoints", async () => {
  const f = await fixture()
  try {
    const approval = {
      type: "approval" as const,
      approvalId: "request",
      request: "command" as const,
      detail: "pwd",
      decision: "pending" as const,
    }
    f.store.appendParts?.({ threadId: "t", messageId: "a", parts: [{ partIndex: 1, part: approval }] })
    f.store.flushWrites?.()
    expect(f.database.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([
      { thread_id: "t", message_id: "a" },
    ])
    const activity = readWorkspaceActivity(f.database).messages.find((message) => message.id === "a")
    expect(JSON.parse(activity?.parts_json ?? "[]")).toEqual([approval])
    const recovered = openDatabase({ filename: f.runtime.kernel.paths.db })
    try {
      const bus = createEventBus(recovered)
      const snapshot = recovered.query("SELECT parts_json FROM messages WHERE id = 'a'").get() as {
        parts_json: string
      }
      expect(JSON.parse(snapshot.parts_json)[1]).toEqual(approval)
      expect(recovered.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([])
      expect(bus.replay(0).some(({ event }) => event.type === "message.created")).toBe(true)
      expect(bus.replay(0).some(({ event }) => event.type === "message.parts")).toBe(true)
      bus.stop()
    } finally {
      recovered.close()
    }
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [{ partIndex: 1, part: { ...approval, decision: "approved" } }],
    })
    f.store.flushWrites?.()
    expect(f.database.query("SELECT decision FROM workspace_message_attention WHERE message_id = 'a'").get()).toEqual({
      decision: "approved",
    })
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [{ partIndex: 1, part: { type: "reasoning", text: "Continuar" } }],
    })
    f.store.flushWrites?.()
    expect(f.database.query("SELECT * FROM workspace_message_attention WHERE message_id = 'a'").all()).toEqual([])
  } finally {
    f.close()
  }
})

test("streamed completed outputs share the inline budget and reserve space for new live progress", async () => {
  const f = await fixture()
  try {
    for (let index = 1; index <= 20; index++)
      f.store.appendParts?.({
        threadId: "t",
        messageId: "a",
        parts: [
          {
            partIndex: index,
            part: {
              type: "command",
              callId: `done-${index}`,
              command: "echo teste",
              cwd: "/tmp",
              exitCode: 0,
              outputTail: `${index}: ${"x".repeat(4000)}`,
            },
          },
        ],
      })
    const outputTail = "p".repeat(16 * 1024)
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [
        {
          partIndex: 21,
          part: {
            type: "command",
            callId: "live",
            command: "echo progresso",
            cwd: "/tmp",
            exitCode: null,
            outputTail,
            resolution: "running",
          },
        },
      ],
    })
    const message = f.store.activePath({ threadId: "t", leafId: "a" })[0]
    expect(message?.parts[21]).toMatchObject({ outputTail })
    const inlineBytes = message?.parts.reduce(
      (total, part) => total + (part.type === "command" ? Buffer.byteLength(part.outputTail) : 0),
      0,
    )
    expect(inlineBytes).toBeLessThanOrEqual(OUTPUT_INLINE_BUDGET_BYTES)
    const patches = f.events.flatMap(({ event }) => (event.type === "message.parts" ? [event] : [])).at(-1)?.parts
    expect(patches?.some(({ partIndex, part }) => partIndex < 21 && "outputAttachmentId" in part)).toBe(true)
  } finally {
    f.close()
  }
})

test("8 KiB flushes immediately, splits large UTF-8 frames, and terminal writes drain the remainder", async () => {
  const f = await fixture()
  try {
    const delta = "🚀".repeat(5_000)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta })
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(2)
    f.store.updateMessage({ threadId: "t", messageId: "a", patch: { status: "complete" } })
    const deltas = f.events.flatMap(({ event }) => (event.type === "message.delta" ? [event] : []))
    expect(deltas.map((event) => event.delta).join("")).toBe(delta)
    expect(deltas.every((event) => Buffer.byteLength(event.delta) <= STREAM_WRITE_LIMITS.bytes)).toBe(true)
    expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe(delta)
  } finally {
    f.close()
  }
})

test("starting another message does not checkpoint an unrelated streaming reply", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: "Parcial" })
    f.store.flushWrites?.()
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Outra" })
    expect(f.database.query("SELECT text FROM messages WHERE id='b'").get()).toEqual({ text: "" })
    expect(f.database.query("SELECT text FROM messages_fts WHERE message_id='b'").get()).toEqual({ text: "" })
  } finally {
    f.close()
  }
})

test("two provider frames cannot overfill the per-message byte budget", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "a".repeat(7_000) })
    expect(f.events).toEqual([])
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "b".repeat(7_000) })
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(1)
    f.store.flushWrites?.()
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(2)
    expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe("a".repeat(7_000) + "b".repeat(7_000))
  } finally {
    f.close()
  }
})

test("an invalid patch list leaves the cached projection unchanged", async () => {
  const f = await fixture()
  try {
    expect(() =>
      f.store.appendParts?.({
        threadId: "t",
        messageId: "a",
        parts: [
          { partIndex: 0, part: { type: "text", text: "Descartar" } },
          { partIndex: 99, part: { type: "reasoning", text: "Inválido" } },
        ],
      }),
    ).toThrow("Invalid stream part index")
    expect(f.events).toEqual([])
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Preservar" })
    f.store.flushWrites?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Preservar" })
    expect(f.events.filter(({ event }) => event.type === "message.parts")).toHaveLength(0)
  } finally {
    f.close()
  }
})

test("small patches cannot overfill a buffered delta batch", async () => {
  const f = await fixture()
  try {
    const text = "a".repeat(7_000)
    const reasoning = "b".repeat(2_000)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: text })
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [{ partIndex: 1, part: { type: "reasoning", text: reasoning } }],
    })
    expect(f.events.map(({ event }) => event.type)).toEqual(["message.delta"])
    f.store.flushWrites?.()
    expect(f.events.map(({ event }) => event.type)).toEqual(["message.delta", "message.parts"])
    materializeTranscript(f.database)
    const row = f.database.query("SELECT text, parts_json FROM messages WHERE id = 'a'").get() as {
      text: string
      parts_json: string
    }
    expect(row.text).toBe(text)
    expect(JSON.parse(row.parts_json)[1]).toMatchObject({ text: reasoning })
  } finally {
    f.close()
  }
})

test("an indivisible large live tail flushes immediately without truncating progress", async () => {
  const f = await fixture()
  try {
    const outputTail = "output".repeat(2_048)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "a".repeat(7_000) })
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [
        {
          partIndex: 1,
          part: {
            type: "command",
            callId: "command",
            command: "printf output",
            cwd: "/tmp",
            exitCode: null,
            outputTail,
            resolution: "running",
          },
        },
      ],
    })
    expect(f.events.map(({ event }) => event.type)).toEqual(["message.delta", "message.parts"])
    const progress = f.events.find(({ event }) => event.type === "message.parts")?.event
    expect(progress?.type === "message.parts" ? progress.parts[0]?.part : null).toMatchObject({ outputTail })
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 })
  } finally {
    f.close()
  }
})

test("a durable projection checkpoint preserves subsequent chunk and frame offsets", async () => {
  const f = await fixture()
  try {
    const text = "界".repeat(7_000)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: text })
    f.store.activePath({ threadId: "t", leafId: "a" })
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "fim" })
    f.store.flushWrites?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: `${text}fim` })
    const deltas = f.events.flatMap(({ event }) => (event.type === "message.delta" ? [event] : []))
    let offset = 0
    for (const event of deltas) {
      expect(event.offset).toBe(offset)
      offset += event.delta.length
    }
    expect(deltas.map((event) => event.delta).join("")).toBe(`${text}fim`)
  } finally {
    f.close()
  }
})

test("patch journal recovers without snapshots, retains ordering and does not borrow mutable parts", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Antes" })
    const part = { type: "reasoning" as const, text: "Pensando", estimatedTokens: 12 }
    f.store.appendParts?.({ threadId: "t", messageId: "a", parts: [{ partIndex: 1, part }] })
    part.text = "Mutação fora da fila"
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 1, delta: " mais" })
    f.store.flushWrites?.()
    expect(f.database.query("SELECT text FROM messages WHERE id='a'").get()).toEqual({ text: "" })
    expect(
      f.database
        .query(
          "SELECT COUNT(*) AS n FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.updated'",
        )
        .get(),
    ).toEqual({ n: 0 })
    const recovered = openDatabase({ filename: f.runtime.kernel.paths.db })
    try {
      const bus = createEventBus(recovered)
      const row = recovered.query("SELECT text, parts_json FROM messages WHERE id='a'").get() as {
        text: string
        parts_json: string
      }
      expect(row.text).toBe("Antes")
      expect(JSON.parse(row.parts_json)[1]).toMatchObject({ text: "Pensando mais" })
      expect(bus.replay(0).filter(({ event }) => event.type === "message.parts")).toHaveLength(1)
      const before = recovered.query("SELECT total_changes() AS n").get()
      materializeTranscript(recovered)
      expect(recovered.query("SELECT total_changes() AS n").get()).toEqual(before)
      bus.stop()
    } finally {
      recovered.close()
    }
  } finally {
    f.close()
  }
})

test("generation changes reject buffered deltas and rollback leaves no queued payload", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Antigo" })
    f.database.exec("UPDATE threads SET generation=generation+1 WHERE id='t'")
    f.store.flushWrites?.()
    expect(f.events.some(({ event }) => event.type === "message.delta")).toBe(false)
    expect(f.database.query("SELECT json_extract(record_json,'$.reason') AS reason FROM rejections").get()).toEqual({
      reason: "stale_generation",
    })
    expect(() =>
      f.database.transaction(() => {
        f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: "Descartar", generation: 1 })
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    await Bun.sleep(STREAM_WRITE_LIMITS.delayMs + 30)
    expect(f.database.query("SELECT COUNT(*) AS n FROM rejections").get()).toEqual({ n: 1 })
  } finally {
    f.close()
  }
})

test("an unrelated pending message cannot conceal a rolled-back cached revision", async () => {
  const f = await fixture()
  try {
    expect(() =>
      f.database.transaction(() => {
        f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "descartar" })
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: "outra" })
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "preservar" })
    f.store.flushWrites?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "preservar" })
    expect(f.database.query("SELECT text FROM messages WHERE id = 'b'").get()).toEqual({ text: "outra" })
  } finally {
    f.close()
  }
})

test("a background transaction failure retries the accepted batch without duplicate publication", async () => {
  const f = await fixture()
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Preservar" })
  const transaction = spyOn(f.database, "transaction").mockImplementationOnce(() => {
    throw new Error("Synthetic storage busy")
  })
  try {
    await Bun.sleep(STREAM_WRITE_LIMITS.delayMs * 3 + 50)
    const deltas = f.events.flatMap(({ event }) => (event.type === "message.delta" ? [event] : []))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.delta).toBe("Preservar")
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Preservar" })
  } finally {
    transaction.mockRestore()
    f.close()
  }
})

test("stream writes retry a busy database without waiting on the main loop", async () => {
  let observedDatabase: Database | null = null
  const timeouts: number[] = []
  const runStage: PerformanceStageRunner = <Value, Input = undefined>(
    stage: string,
    action: (input: Input) => Value,
    input?: Input,
  ): Value => {
    if (stage !== "stream_journal_write" || !observedDatabase) return action(input as Input)
    timeouts.push((observedDatabase.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout)
    return action(input as Input)
  }
  const f = await fixture(runStage)
  cleanups.add(f.close)
  observedDatabase = f.database
  const blocker = new SqliteDatabase(join(f.root, "touri.db"))
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  const log = spyOn(f.runtime.kernel, "log")
  cleanups.add(() => log.mockRestore())

  expect(() =>
    f.store.appendDelta({
      threadId: "t",
      messageId: "a",
      partIndex: 0,
      delta: "x".repeat(STREAM_WRITE_LIMITS.bytes),
    }),
  ).not.toThrow()
  expect(timeouts).toEqual([0])
  expect((f.database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5_000)
  expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(0)

  f.store.flushWrites?.()
  f.store.flushWrites?.()
  expect(
    log.mock.calls.filter(([entry]) => entry.msg === "Stream database busy; retrying buffered writes"),
  ).toHaveLength(1)

  blocker.exec("ROLLBACK")
  f.store.flushWrites?.()

  expect(timeouts).toEqual([0, 0, 0, 0])
  expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(1)
  expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe("x".repeat(STREAM_WRITE_LIMITS.bytes))
})

test("shutdown warns about busy buffered writes and cancels retries before closing the database", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  f.runtime.kernel.services.use("storage.maintenance")?.dispose()
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Preservar" })
  const blocker = new SqliteDatabase(join(f.root, "touri.db"))
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  const log = spyOn(f.runtime.kernel, "log")
  cleanups.add(() => log.mockRestore())

  expect(() => f.runtime.stop()).not.toThrow()
  expect(() => f.runtime.stop()).not.toThrow()
  expect(() => f.store.flushWrites?.()).not.toThrow()

  expect(log.mock.calls.map(([entry]) => entry)).toContainEqual({
    level: "warn",
    module: "store",
    msg: "Shutdown could not persist buffered stream writes; database remains busy",
    data: { events: 1, bytes: Buffer.byteLength("Preservar") },
  })
  expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(0)
})

test("an explicit flush also drains parts mirrored reentrantly during committed event publication", async () => {
  const f = await fixture()
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
    if (event.type !== "message.delta" || event.messageId !== "a") return
    f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: event.delta })
  })
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Espelhado" })
    f.store.flushWrites?.()
    const deltas = f.database
      .query(
        "SELECT json_extract(event_json, '$.messageId') AS id FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.delta' ORDER BY id",
      )
      .all()
    expect(deltas).toEqual([{ id: "a" }, { id: "b" }])
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(2)
  } finally {
    unsubscribe()
    f.close()
  }
})

test("retention of a referenced patch requests resync rather than silently dropping progress", async () => {
  const f = await fixture()
  try {
    const bus = createEventBus(f.database)
    const cursor = bus.replay(0).at(-1)?.seq ?? 0
    for (let index = 0; index < 5; index++) {
      f.store.appendParts?.({
        threadId: "t",
        messageId: "a",
        parts: [{ partIndex: 1, part: { type: "reasoning", text: `${index}` } }],
      })
      f.store.flushWrites?.()
    }
    compactTranscript({ database: f.database, entriesPerThread: 2, events: 100, maxAgeMs: Number.MAX_SAFE_INTEGER })
    expect(bus.catchUp(cursor)).toMatchObject([{ event: { type: "transcript.resync" } }])
    expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.parts[1]).toMatchObject({ text: "4" })
    bus.stop()
  } finally {
    f.close()
  }
})

test("large WAL stream writes keep autocheckpointing disabled and cap journal rows per transaction", async () => {
  let observedDatabase: Database | null = null
  const writerRows: number[] = []
  const writerDurations: number[] = []
  const stages: string[] = []
  const getLastSeq = (database: Database): number =>
    (
      database.query("SELECT MAX(seq) AS seq FROM transcript_entries WHERE thread_id = 't'").get() as {
        seq: number | null
      }
    ).seq ?? 0
  const runStage: PerformanceStageRunner = <Value, Input = undefined>(
    stage: string,
    action: (input: Input) => Value,
    input?: Input,
  ): Value => {
    stages.push(stage)
    if (stage !== "stream_journal_write" || !observedDatabase) return action(input as Input)
    const before = getLastSeq(observedDatabase)
    const startedAt = performance.now()
    const result = action(input as Input)
    writerDurations.push(performance.now() - startedAt)
    writerRows.push(getLastSeq(observedDatabase) - before)
    return result
  }
  const f = await fixture(runStage)
  cleanups.add(f.close)
  observedDatabase = f.database

  f.runtime.kernel.services.use("storage.maintenance")?.dispose()
  f.database.exec("PRAGMA wal_autocheckpoint = 0")
  for (let index = 0; index < MAX_STREAM_EVENTS_PER_WRITE + 36; index++) {
    const result = f.store.insertMessage({
      message: {
        id: `stream-${index}`,
        threadId: "t",
        parentId: null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: null,
        text: "",
        parts: [{ type: "text", text: "" }],
        sender: null,
        source: "local",
      },
    })
    expect(result.success).toBe(true)
  }

  const previousAutocheckpoint = (
    f.database.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number
    }
  ).wal_autocheckpoint
  f.database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0")
  const firstSyntheticSeq =
    (
      f.database.query("SELECT updated_seq FROM threads WHERE id = 't'").get() as {
        updated_seq: number
      }
    ).updated_seq + 1
  const history = JSON.stringify({ type: "legacy", legacy: true, payload: "x".repeat(1_024) })
  const insertHistory = f.database.query(
    "INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES ('t', ?, 1, ?, ?)",
  )
  const historyRows = 20_000
  f.database.transaction(() => {
    for (let index = 0; index < historyRows; index++) insertHistory.run(firstSyntheticSeq + index, history, index)
  })()
  const finalSyntheticSeq = firstSyntheticSeq + historyRows - 1
  const lastEntryId = (f.database.query("SELECT MAX(id) AS id FROM transcript_entries").get() as { id: number }).id
  f.database.query("UPDATE threads SET updated_seq = ? WHERE id = 't'").run(finalSyntheticSeq)
  f.database
    .query("UPDATE schema_meta SET value = ? WHERE key = 'transcript_event_checkpoint'")
    .run(String(lastEntryId))
  f.database.exec(`PRAGMA wal_autocheckpoint = ${previousAutocheckpoint}`)

  const walBytes = statSync(join(f.root, "touri.db-wal")).size
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 10_000)
  cleanups.add(() => clock.mockRestore())
  const delivered = Promise.withResolvers<void>()
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
    if (event.type === "message.delta" && event.messageId === "stream-99") delivered.resolve()
  })
  cleanups.add(unsubscribe)
  const firstDeltaEvent = f.events.length

  for (let index = 0; index < MAX_STREAM_EVENTS_PER_WRITE + 36; index++)
    f.store.appendDelta({ threadId: "t", messageId: `stream-${index}`, partIndex: 0, delta: "x" })
  f.store.flushWrites?.()
  await delivered.promise

  const elapsedMs = Math.round(writerDurations.reduce((total, duration) => total + duration, 0))
  console.info(`stream-write-large-wal ${JSON.stringify({ historyRows, walBytes, writerRows, writerMs: elapsedMs })}`)
  expect(walBytes).toBeGreaterThan(16 * 1024 * 1024)
  expect(writerRows.length).toBe(2)
  expect(writerRows.every((rows) => rows > 0 && rows <= MAX_STREAM_EVENTS_PER_WRITE)).toBe(true)
  expect(f.events.slice(firstDeltaEvent).filter(({ event }) => event.type === "message.delta")).toHaveLength(100)
  expect(
    (f.database.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint,
  ).toBe(0)
  expect(stages.filter((stage) => stage === "transcript_projection_checkpoint").length).toBeLessThanOrEqual(1)
})
