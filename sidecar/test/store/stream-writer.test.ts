import { type Database, Database as SqliteDatabase } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { OUTPUT_INLINE_BUDGET_BYTES } from "../../src/kernel/output-blobs"
import type { PerformanceStageRunner } from "../../src/kernel/performance"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { compactTranscript, materializeTranscript } from "../../src/kernel/transcript-storage"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { streamPersistenceWorkerSource } from "../../src/store/stream-persistence-worker"
import { STREAM_WRITE_LIMITS } from "../../src/store/stream-writer"
import { readWorkspaceActivity } from "../../src/store/workspace-activity"

const MAX_STREAM_EVENTS_PER_WRITE = STREAM_WRITE_LIMITS.batchEvents

const fixture = async (runStage?: PerformanceStageRunner, createWorker?: (url: string) => Worker) => {
  const root = mkdtempSync(join(tmpdir(), "touri-stream-writer-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel, runStage, createWorker)
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
    close: async () => {
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("one worker commit publishes the message projection, journal and tool resolution together", async () => {
  const f = await fixture()
  try {
    const run: Run = {
      id: "run",
      botId: "b",
      threadId: "t",
      provider: "codex",
      trigger: "user",
      requestMessageId: null,
      replyMessageId: "a",
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: 1,
      startedAt: 1,
      finishedAt: null,
    }
    expect(createRuntimePersistence({ database: f.database }).saveRun(run)).toBe(true)
    f.database.query("UPDATE messages SET run_id = 'run' WHERE thread_id = 't' AND id = 'a'").run()
    const observed: Array<{ type: string; committedTogether: boolean }> = []
    const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
      if (event.type !== "message.delta" && event.type !== "message.parts") return
      const journalRows = (
        f.database.query("SELECT COUNT(*) AS count FROM transcript_entries WHERE thread_id = 't'").get() as {
          count: number
        }
      ).count
      const resolution = f.database.query("SELECT resolution FROM tool_resolutions WHERE run_id = 'run'").get()
      observed.push({ type: event.type, committedTogether: journalRows >= 4 && Boolean(resolution) })
    })

    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Resposta" })
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [
        {
          partIndex: 1,
          part: {
            type: "tool_call",
            callId: "call",
            tool: "fixture_tool",
            summary: "Synthetic result",
            inputJson: "{}",
            outputJson: "done",
            ok: true,
            resolution: "succeeded",
            resolvedAt: 2,
          },
        },
      ],
    })
    await f.store.flushWritesAsync?.()

    expect(observed.map(({ type }) => type)).toEqual(["message.delta", "message.parts"])
    expect(observed.every(({ committedTogether }) => committedTogether)).toBe(true)
    expect(f.database.query("SELECT resolution FROM tool_resolutions WHERE run_id = 'run'").get()).toEqual({
      resolution: "succeeded",
    })
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Resposta" })
    unsubscribe()
  } finally {
    await f.close()
  }
})

test("projection validation scales with journal batches rather than provider deltas", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  const query = spyOn(f.database, "query")
  cleanups.add(() => query.mockRestore())

  Array.from({ length: 1_000 }, () => f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "x" }))
  await f.store.flushWritesAsync?.()
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
  await f.store.flushWritesAsync?.()
  materializeTranscript(f.database)
  const query = spyOn(f.database, "query")
  cleanups.add(() => query.mockRestore())

  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: " depois" })
  f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: " depois" })
  await f.store.flushWritesAsync?.()
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
    await Promise.race([
      (async () => {
        while (f.events.filter(({ event }) => event.type === "message.delta").length < 2) await Bun.sleep(10)
      })(),
      Bun.sleep(2_000).then(() => {
        throw new Error("Timed stream batch was not published")
      }),
    ])
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
    await f.close()
  }
})

test("shutdown drains accepted text and can be repeated after the database closes", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Preservar" })
    const stopping = f.runtime.stop()
    expect(f.runtime.stop()).toBe(stopping)
    await stopping
    const recovered = openDatabase({ filename: join(f.root, "touri.db") })
    try {
      materializeTranscript(recovered)
      expect(recovered.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Preservar" })
    } finally {
      recovered.close()
    }
  } finally {
    await f.close()
  }
})

test("part-only commits keep workspace approvals current and recover after restart", async () => {
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
    await f.store.flushWritesAsync?.()
    expect(f.database.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([])
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
    await f.store.flushWritesAsync?.()
    expect(f.database.query("SELECT decision FROM workspace_message_attention WHERE message_id = 'a'").get()).toEqual({
      decision: "approved",
    })
    f.store.appendParts?.({
      threadId: "t",
      messageId: "a",
      parts: [{ partIndex: 1, part: { type: "reasoning", text: "Continuar" } }],
    })
    await f.store.flushWritesAsync?.()
    expect(f.database.query("SELECT * FROM workspace_message_attention WHERE message_id = 'a'").all()).toEqual([])
  } finally {
    await f.close()
  }
})

test("one stream patch can append many contiguous parts and replay them", async () => {
  const f = await fixture()
  try {
    const parts = Array.from({ length: 64 }, (_, index) => ({
      partIndex: index + 1,
      part: { type: "reasoning" as const, text: `passo-${index}` },
    }))
    f.store.appendParts?.({ threadId: "t", messageId: "a", parts })
    await f.store.flushWritesAsync?.()

    f.database.exec("UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1")
    f.database.exec(`UPDATE messages SET updated_seq = 0, parts_json = '[{"type":"text","text":""}]', text = ''
      WHERE thread_id = 't' AND id = 'a'`)
    f.database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1")
    f.database.query("INSERT OR IGNORE INTO transcript_pending_deltas(thread_id, message_id) VALUES ('t', 'a')").run()
    materializeTranscript(f.database, { threadId: "t", messageId: "a" })

    const snapshot = f.database.query("SELECT parts_json FROM messages WHERE thread_id = 't' AND id = 'a'").get() as {
      parts_json: string
    }
    const expected = [{ type: "text", text: "" }].concat(parts.map(({ part }) => part))
    expect(JSON.parse(snapshot.parts_json)).toEqual(expected)
    expect(f.database.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([])
  } finally {
    await f.close()
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
    await f.store.flushWritesAsync?.()
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
    await f.close()
  }
})

test("8 KiB flushes immediately, splits large UTF-8 frames, and terminal writes drain the remainder", async () => {
  const f = await fixture()
  try {
    const delta = "🚀".repeat(5_000)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta })
    await f.store.flushWritesAsync?.()
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(3)
    f.store.updateMessage({ threadId: "t", messageId: "a", patch: { status: "complete" } })
    const deltas = f.events.flatMap(({ event }) => (event.type === "message.delta" ? [event] : []))
    expect(deltas.map((event) => event.delta).join("")).toBe(delta)
    expect(deltas.every((event) => Buffer.byteLength(event.delta) <= STREAM_WRITE_LIMITS.bytes)).toBe(true)
    expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe(delta)
  } finally {
    await f.close()
  }
})

test("starting another message preserves the committed projection of a streaming reply", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: "Parcial" })
    await f.store.flushWritesAsync?.()
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Outra" })
    expect(f.database.query("SELECT text FROM messages WHERE id='b'").get()).toEqual({ text: "Parcial" })
    expect(f.database.query("SELECT text FROM messages_fts WHERE message_id='b'").get()).toEqual({ text: "Parcial" })
  } finally {
    await f.close()
  }
})

test("two provider frames cannot overfill the per-message byte budget", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "a".repeat(7_000) })
    expect(f.events).toEqual([])
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "b".repeat(7_000) })
    expect(f.events).toEqual([])
    await f.store.flushWritesAsync?.()
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(2)
    expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe("a".repeat(7_000) + "b".repeat(7_000))
  } finally {
    await f.close()
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
    await f.store.flushWritesAsync?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Preservar" })
    expect(f.events.filter(({ event }) => event.type === "message.parts")).toHaveLength(0)
  } finally {
    await f.close()
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
    expect(f.events).toEqual([])
    await f.store.flushWritesAsync?.()
    expect(f.events.map(({ event }) => event.type)).toEqual(["message.delta", "message.parts"])
    materializeTranscript(f.database)
    const row = f.database.query("SELECT text, parts_json FROM messages WHERE id = 'a'").get() as {
      text: string
      parts_json: string
    }
    expect(row.text).toBe(text)
    expect(JSON.parse(row.parts_json)[1]).toMatchObject({ text: reasoning })
  } finally {
    await f.close()
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
    await f.store.flushWritesAsync?.()
    expect(f.events.map(({ event }) => event.type)).toEqual(["message.delta", "message.parts"])
    const progress = f.events.find(({ event }) => event.type === "message.parts")?.event
    expect(progress?.type === "message.parts" ? progress.parts[0]?.part : null).toMatchObject({ outputTail })
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 })
  } finally {
    await f.close()
  }
})

test("a durable projection checkpoint preserves subsequent chunk and frame offsets", async () => {
  const f = await fixture()
  try {
    const text = "界".repeat(7_000)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: text })
    f.store.activePath({ threadId: "t", leafId: "a" })
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "fim" })
    await f.store.flushWritesAsync?.()
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
    await f.close()
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
    await f.store.flushWritesAsync?.()
    expect(f.database.query("SELECT text FROM messages WHERE id='a'").get()).toEqual({ text: "Antes" })
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
    await f.close()
  }
})

test("generation changes reject buffered deltas and rollback leaves no queued payload", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Antigo" })
    f.database.exec("UPDATE threads SET generation=generation+1 WHERE id='t'")
    await f.store.flushWritesAsync?.()
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
    await f.close()
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
    await f.store.flushWritesAsync?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "preservar" })
    expect(f.database.query("SELECT text FROM messages WHERE id = 'b'").get()).toEqual({ text: "outra" })
  } finally {
    await f.close()
  }
})

test("a worker transaction failure retries the accepted batch without duplicate publication", async () => {
  const f = await fixture()
  try {
    f.database.exec(`CREATE TRIGGER fail_stream_write BEFORE INSERT ON transcript_entries
      WHEN json_extract(NEW.event_json, '$.type') = 'message.delta'
      BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END`)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Preservar" })
    await Bun.sleep(STREAM_WRITE_LIMITS.delayMs * 2)
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(0)
    f.database.exec("DROP TRIGGER fail_stream_write")
    await f.store.flushWritesAsync?.()
    const deltas = f.events.flatMap(({ event }) => (event.type === "message.delta" ? [event] : []))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.delta).toBe("Preservar")
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'a'").get()).toEqual({ text: "Preservar" })
  } finally {
    await f.close()
  }
})

test("stream writes retry a busy database without waiting on the main loop", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  const blocker = new SqliteDatabase(join(f.root, "touri.db"))
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  let timerFired = false
  const timer = setTimeout(() => {
    timerFired = true
  }, 10)
  cleanups.add(() => clearTimeout(timer))

  expect(() =>
    f.store.appendDelta({
      threadId: "t",
      messageId: "a",
      partIndex: 0,
      delta: "x".repeat(STREAM_WRITE_LIMITS.bytes),
    }),
  ).not.toThrow()
  expect((f.database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5_000)
  expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(0)
  await Bun.sleep(30)
  expect(timerFired).toBe(true)

  blocker.exec("ROLLBACK")
  await f.store.flushWritesAsync?.()

  expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(1)
  expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text).toBe("x".repeat(STREAM_WRITE_LIMITS.bytes))
})

// Two drain deadlines and SQLite's existing busy timeout exceed the runner's five-second default.
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

  await f.runtime.stop()

  expect(log.mock.calls.map(([entry]) => entry)).toContainEqual({
    level: "warn",
    module: "store",
    msg: "Shutdown could not persist buffered stream writes; database remains busy",
    data: { events: 1, bytes: Buffer.byteLength("Preservar") },
  })
  expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(0)
}, 10_000)

test("a subsequent flush drains parts mirrored after the first flush watermark", async () => {
  const f = await fixture()
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
    if (event.type !== "message.delta" || event.messageId !== "a") return
    f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: event.delta })
  })
  try {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Espelhado" })
    await f.store.flushWritesAsync?.()
    await f.store.flushWritesAsync?.()
    const deltas = f.database
      .query(
        "SELECT json_extract(event_json, '$.messageId') AS id FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.delta' ORDER BY id",
      )
      .all()
    expect(deltas).toEqual([{ id: "a" }, { id: "b" }])
    expect(f.events.filter(({ event }) => event.type === "message.delta")).toHaveLength(2)
  } finally {
    unsubscribe()
    await f.close()
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
      await f.store.flushWritesAsync?.()
    }
    const latestEntry = (
      f.database.query("SELECT MAX(id) AS id FROM transcript_entries").get() as { id: number | null }
    ).id
    if (latestEntry === null) throw new Error("Missing transcript entries")
    const checkpointDeadline = Date.now() + 2_000
    let checkpoint = 0
    let storageUpgrade: string | null = null
    while (Date.now() < checkpointDeadline) {
      checkpoint = Number(
        (
          f.database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
            value: string
          }
        ).value,
      )
      storageUpgrade =
        (
          f.database.query("SELECT value FROM schema_meta WHERE key = 'storage_upgrade_22'").get() as {
            value: string
          } | null
        )?.value ?? null
      if (checkpoint >= latestEntry && storageUpgrade === "done") break
      await Bun.sleep(10)
    }
    expect(checkpoint).toBe(latestEntry)
    expect([null, "done"]).toContain(storageUpgrade)
    compactTranscript({ database: f.database, entriesPerThread: 2, events: 100, maxAgeMs: Number.MAX_SAFE_INTEGER })
    expect(bus.catchUp(cursor)).toMatchObject([{ event: { type: "transcript.resync" } }])
    expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.parts[1]).toMatchObject({ text: "4" })
    bus.stop()
  } finally {
    await f.close()
  }
})

test("large WAL stream batches preserve ordered journal entries", async () => {
  const f = await fixture()
  cleanups.add(f.close)

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
  await f.store.flushWritesAsync?.()
  await delivered.promise

  console.info(`stream-write-large-wal ${JSON.stringify({ historyRows, walBytes })}`)
  expect(walBytes).toBeGreaterThan(16 * 1024 * 1024)
  expect(f.events.slice(firstDeltaEvent).filter(({ event }) => event.type === "message.delta")).toHaveLength(100)
  const rows = f.database
    .query(`SELECT json_extract(event_json, '$.messageId') AS message_id, seq
      FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.delta'
        AND json_extract(event_json, '$.messageId') LIKE 'stream-%' ORDER BY seq`)
    .all() as Array<{ message_id: string; seq: number }>
  expect(rows).toHaveLength(100)
  expect(rows.map(({ message_id }) => message_id)).toEqual(Array.from({ length: 100 }, (_, index) => `stream-${index}`))
})

test("a cached projection stays available while its worker batch is in flight", async () => {
  const url = URL.createObjectURL(
    new Blob(
      [
        streamPersistenceWorkerSource.replace(
          "const result = database.transaction(() => writeBatch(data.batch)).immediate();",
          `const result = database.transaction(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return writeBatch(data.batch);
    }).immediate();`,
        ),
      ],
      { type: "application/javascript" },
    ),
  )
  cleanups.add(() => URL.revokeObjectURL(url))
  const f = await fixture(undefined, () => new Worker(url, { smol: true, ref: false }))
  cleanups.add(f.close)
  f.store.appendParts?.({
    threadId: "t",
    messageId: "a",
    parts: [{ partIndex: 1, part: { type: "reasoning", text: "Primeiro" } }],
  })
  const drain = f.store.flushWritesAsync?.()
  if (!drain) throw new Error("Missing asynchronous durability boundary")
  const query = spyOn(f.database, "query")
  cleanups.add(() => query.mockRestore())

  f.store.appendParts?.({
    threadId: "t",
    messageId: "a",
    parts: [{ partIndex: 2, part: { type: "reasoning", text: "Segundo" } }],
  })

  expect(
    query.mock.calls.filter(([sql]) => sql.includes("SELECT updated_seq, generation, status FROM messages")),
  ).toEqual([])
  await drain
  await f.store.flushWritesAsync?.()
  const message = f.store.activePath({ threadId: "t", leafId: "a" })[0]
  expect(message?.parts.slice(1)).toEqual([
    { type: "reasoning", text: "Primeiro" },
    { type: "reasoning", text: "Segundo" },
  ])
})

test("drain waits for its watermark while another stream keeps accepting events", async () => {
  const url = URL.createObjectURL(
    new Blob(
      [
        streamPersistenceWorkerSource.replace(
          "const result = database.transaction(() => writeBatch(data.batch)).immediate();",
          `const result = database.transaction(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      return writeBatch(data.batch);
    }).immediate();`,
        ),
      ],
      { type: "application/javascript" },
    ),
  )
  cleanups.add(() => URL.revokeObjectURL(url))
  const f = await fixture(undefined, () => new Worker(url, { smol: true, ref: false }))
  cleanups.add(f.close)
  Array.from({ length: 8 }).forEach(() => {
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "x".repeat(8192) })
  })
  const timer = setInterval(
    () => f.store.appendDelta({ threadId: "t", messageId: "b", partIndex: 0, delta: "y".repeat(8192) }),
    5,
  )
  cleanups.add(() => clearInterval(timer))
  const started = performance.now()
  const deadline = setTimeout(() => clearInterval(timer), 1000)
  cleanups.add(() => clearTimeout(deadline))

  await f.store.flushWritesAsync?.()
  const elapsedMs = performance.now() - started
  clearInterval(timer)

  expect(elapsedMs).toBeLessThan(750)
  expect(f.database.query("SELECT text FROM messages WHERE id='a'").get()).toEqual({ text: "x".repeat(8 * 8192) })
  await f.store.flushWritesAsync?.()
})

test.each(["parts", "text", "status"] as const)(
  "synchronous %s snapshots supersede queued deltas without loss or duplication",
  async (field) => {
    const f = await fixture()
    cleanups.add(f.close)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "preservado" })
    const patch =
      field === "status"
        ? { status: "complete" as const }
        : field === "parts"
          ? { parts: [{ type: "text" as const, text: "preservado" }] }
          : { text: "substituído", parts: [{ type: "text" as const, text: "substituído" }] }

    expect(f.store.updateMessage({ threadId: "t", messageId: "a", patch }).success).toBe(true)
    await f.store.flushWritesAsync?.()

    const text = field === "text" ? "substituído" : "preservado"
    expect(f.database.query("SELECT text,parts_json FROM messages WHERE id='a'").get()).toEqual({
      text,
      parts_json: JSON.stringify([{ type: "text", text }]),
    })
  },
)

test("a synchronous replacement also fences a batch already submitted to the worker", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "x".repeat(8192) })

  f.store.updateMessage({
    threadId: "t",
    messageId: "a",
    patch: { text: "snapshot", parts: [{ type: "text", text: "snapshot" }] },
  })
  await f.store.flushWritesAsync?.()
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: " novo" })
  await f.store.flushWritesAsync?.()

  expect(f.database.query("SELECT text FROM messages WHERE id='a'").get()).toEqual({ text: "snapshot novo" })
})

test("a stopped worker cannot grow writer buffers or projections past the byte limit", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  const log = spyOn(f.runtime.kernel, "log")
  cleanups.add(() => log.mockRestore())
  const blocker = new SqliteDatabase(join(f.root, "touri.db"))
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  const input = { threadId: "t", messageId: "a", partIndex: 0, delta: "\u0000".repeat(256 * 1024) }
  const accepted = Array.from({ length: 40 }).reduce<number>((count) => {
    try {
      f.store.appendDelta(input)
      return count + 1
    } catch (error) {
      expect(String(error)).toContain("buffer limit")
      return count
    }
  }, 0)

  expect(accepted).toBeGreaterThan(0)
  expect(accepted * Buffer.byteLength(JSON.stringify(input.delta))).toBeLessThanOrEqual(
    STREAM_WRITE_LIMITS.pendingBytes,
  )
  expect(f.store.activePath({ threadId: "t", leafId: "a" })[0]?.text.length).toBe(accepted * input.delta.length)
  expect(log.mock.calls.map(([entry]) => entry.msg)).toContain(
    "Stream buffer limit reached; rejecting additional writes",
  )
  blocker.exec("ROLLBACK")
  await f.store.flushWritesAsync?.()
}, 15_000)

test("quarantined writes fail their durability boundary before approval can continue", async () => {
  const batchErrors: boolean[] = []
  const f = await fixture(undefined, (url) => {
    const worker = new Worker(url, { smol: true, ref: false })
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "batch-error") batchErrors.push(data.busy)
    })
    return worker
  })
  cleanups.add(f.close)
  f.database.exec(`CREATE TRIGGER fail_stream BEFORE INSERT ON transcript_entries
    WHEN json_extract(NEW.event_json,'$.type') = 'message.delta'
    BEGIN SELECT RAISE(ABORT, 'Synthetic permanent failure'); END`)
  expect(f.database.inTransaction).toBe(false)
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "não confirmado" })
  const drained = f.store.flushWritesAsync?.()
  if (!drained) throw new Error("Missing asynchronous durability boundary")
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          new Error(
            `Durability did not settle: ${JSON.stringify({ batchErrors, inTransaction: f.database.inTransaction })}`,
          ),
        ),
      2500,
    )
  })
  cleanups.add(() => clearTimeout(timer))

  const failure = await Promise.race([
    drained.then(
      () => null,
      (error: unknown) => error,
    ),
    deadline,
  ])

  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("Missing durability rejection")
  expect(failure.message).toBe("Stream writes were rejected")
  expect(batchErrors.filter((busy) => !busy)).toHaveLength(4)
  expect(f.events.some(({ event }) => event.type === "message.delta")).toBe(false)
  expect(f.database.query("SELECT COUNT(*) AS n FROM rejections").get()).toEqual({ n: 1 })
})

test("a scoped drain ignores a rejected message from another thread", async () => {
  const f = await fixture()
  cleanups.add(f.close)
  f.database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('other','b','Outra',1,1)")
  const created = f.store.insertMessage({
    message: {
      id: "other-reply",
      threadId: "other",
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
  if (!created.success) throw new Error(created.error)
  f.database.exec(`CREATE TRIGGER fail_other_stream BEFORE INSERT ON transcript_entries
    WHEN NEW.thread_id = 'other' AND json_extract(NEW.event_json,'$.type') = 'message.delta'
    BEGIN SELECT RAISE(ABORT, 'Synthetic permanent failure'); END`)

  f.store.appendDelta({ threadId: "other", messageId: "other-reply", partIndex: 0, delta: "Rejeitado" })
  f.store.flushWrites?.()
  f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: "Confirmado" })

  const drained = f.store.flushWritesAsync?.({ threadId: "t", messageId: "a" })
  if (!drained) throw new Error("Missing asynchronous stream drain")
  await drained

  expect(f.database.query("SELECT text FROM messages WHERE thread_id = 't' AND id = 'a'").get()).toEqual({
    text: "Confirmado",
  })
  expect(f.database.query("SELECT COUNT(*) AS n FROM rejections WHERE thread_id = 'other'").get()).toEqual({ n: 1 })
}, 20_000)

test("rejected writes in another thread do not fail its message or search routes", async () => {
  const started = Promise.withResolvers<void>()
  const rejected = Promise.withResolvers<void>()
  const source = streamPersistenceWorkerSource.replace(
    "const result = database.transaction(() => writeBatch(data.batch)).immediate();",
    `const result = database.transaction(() => {
      self.postMessage({ type: "test-batch-started" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      return writeBatch(data.batch);
    }).immediate();`,
  )
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  cleanups.add(() => URL.revokeObjectURL(url))
  const f = await fixture(undefined, () => {
    const worker = new Worker(url, { smol: true, ref: false })
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "test-batch-started") started.resolve()
      if (data.type === "committed" && data.rejected.length) rejected.resolve()
    })
    return worker
  })
  cleanups.add(f.close)
  f.database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('other','b','Outra',1,1)")
  const updated = f.store.updateMessage({
    threadId: "t",
    messageId: "a",
    patch: { status: "complete", text: "needle B", parts: [{ type: "text", text: "needle B" }] },
  })
  if (!updated.success) throw new Error(updated.error)
  const match = f.store.insertMessage({
    message: {
      id: "other-match",
      threadId: "other",
      parentId: null,
      role: "assistant",
      kind: "text",
      status: "complete",
      runId: null,
      text: "needle A",
      parts: [{ type: "text", text: "needle A" }],
      sender: null,
      source: "local",
    },
  })
  if (!match.success) throw new Error(match.error)
  const streamed = f.store.insertMessage({
    message: {
      id: "other-reply",
      threadId: "other",
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
  if (!streamed.success) throw new Error(streamed.error)
  f.database.exec(`CREATE TRIGGER fail_other_stream BEFORE INSERT ON transcript_entries
    WHEN NEW.thread_id = 'other' AND json_extract(NEW.event_json,'$.type') = 'message.delta'
    BEGIN SELECT RAISE(ABORT, 'Synthetic permanent failure'); END`)
  f.store.appendDelta({ threadId: "other", messageId: "other-reply", partIndex: 0, delta: "rejected" })
  f.store.flushWrites?.()
  await started.promise

  const base = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1`
  const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
  const [messagesResponse, searchResponse] = await Promise.all([
    fetch(`${base}/threads/t/messages`, { headers }),
    fetch(`${base}/search?q=needle&threadId=t`, { headers }),
  ])
  const searchPayload = (await searchResponse.json()) as { hits: Array<{ threadId: string; messageId: string }> }

  expect(messagesResponse.status).toBe(200)
  expect(searchResponse.status).toBe(200)
  expect(searchPayload.hits.map(({ threadId, messageId }) => [threadId, messageId])).toContainEqual(["t", "a"])
  expect(searchPayload.hits.map(({ threadId }) => threadId)).not.toContain("other")
  await rejected.promise
  expect(f.database.query("SELECT COUNT(*) AS n FROM rejections WHERE thread_id = 'other'").get()).toEqual({ n: 1 })
}, 20_000)
