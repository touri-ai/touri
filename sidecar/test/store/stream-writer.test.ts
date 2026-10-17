import type { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { compactTranscript, materializeTranscript } from "../../src/kernel/transcript-storage"
import { init as initStore } from "../../src/store"
import { STREAM_WRITE_LIMITS } from "../../src/store/stream-writer"

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-stream-writer-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
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

test("a periodic checkpoint inside a large frame preserves subsequent chunk and frame offsets", async () => {
  const f = await fixture()
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now + STREAM_WRITE_LIMITS.checkpointMs + 1)
  try {
    const text = "界".repeat(7_000)
    f.store.appendDelta({ threadId: "t", messageId: "a", partIndex: 0, delta: text })
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
    clock.mockRestore()
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
