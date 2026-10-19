import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { captureTranscript } from "../../src/kernel/transcript-events"
import { materializeTranscript } from "../../src/kernel/transcript-storage"
import { init as initStore } from "../../src/store"
import { STREAM_WRITE_LIMITS } from "../../src/store/stream-writer"

type Delta = Extract<UiEvent, { type: "message.delta" }>

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("batch validation rebases every buffered delta when another connection writes between appends", async () => {
  const f = await fixture()
  cleanups.add(f.close)

  f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "a" })
  f.appendFromSecondConnection("b", 0)
  f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "c" })
  await f.store.flushWritesAsync?.()
  materializeTranscript(f.database)

  expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "bac" })
  expect(f.deltas().map(({ delta, offset }) => [delta, offset])).toEqual([
    ["b", 0],
    ["ac", 1],
  ])
})

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-stream-concurrency-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste',?,'/tmp',1,1)")
    .run(profileProviders[0])
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const created = store.insertMessage({
    message: {
      id: "reply",
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
  if (!created.success) throw new Error(created.error)
  const second = openDatabase({ filename: runtime.kernel.paths.db })
  const events: UiEventEnvelope[] = []
  const unsubscribe = runtime.kernel.subscribe((event) => events.push(structuredClone(event)))
  const appendFromSecondConnection = (delta: string, offset: number): void => {
    second.transaction(() => {
      const thread = second.query("SELECT updated_seq, generation FROM threads WHERE id = 't'").get() as {
        updated_seq: number
        generation: number
      }
      const event: Delta = {
        type: "message.delta",
        threadId: "t",
        messageId: "reply",
        partIndex: 0,
        partType: "text",
        delta,
        offset,
        updatedSeq: thread.updated_seq + 1,
        generation: thread.generation,
        updatedAt: Date.now(),
      }
      second.query("UPDATE threads SET updated_seq = ? WHERE id = 't'").run(event.updatedSeq ?? 0)
      second
        .query("INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at) VALUES (?, ?, ?, ?, ?)")
        .run("t", event.updatedSeq ?? 0, thread.generation, JSON.stringify(event), event.updatedAt ?? Date.now())
      captureTranscript(second)
    })()
  }
  const deltas = (): Delta[] =>
    (
      database
        .query(
          "SELECT event_json FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.delta' ORDER BY id",
        )
        .all() as { event_json: string }[]
    ).map(({ event_json }) => JSON.parse(event_json) as Delta)
  return {
    database,
    store,
    events,
    appendFromSecondConnection,
    deltas,
    close: async () => {
      unsubscribe()
      second.close()
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a rolled-back reader transaction preserves previously accepted text and discards its own text", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "fora" })
    expect(() =>
      f.database.transaction(() => {
        expect(f.store.activePath({ threadId: "t", leafId: "reply" })[0]?.text).toBe("fora")
        f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "dentro" })
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: " depois" })
    await f.store.flushWritesAsync?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "fora depois" })
    expect(
      f
        .deltas()
        .map((event) => event.delta)
        .join(""),
    ).toBe("fora depois")
    await Bun.sleep(0)
    expect(JSON.stringify(f.events)).not.toContain("dentro")
  } finally {
    await f.close()
  }
})

test("a buffered append rebases after a second SQLite connection commits first", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "a" })
    f.appendFromSecondConnection("b", 0)
    await f.store.flushWritesAsync?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "ba" })
    expect(f.deltas().map(({ delta, offset }) => [delta, offset])).toEqual([
      ["b", 0],
      ["a", 1],
    ])
  } finally {
    await f.close()
  }
})

test("a cached stream observes a durable tail appended by another SQLite connection", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "a" })
    await f.store.flushWritesAsync?.()
    f.appendFromSecondConnection("b", 1)
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "c" })
    await f.store.flushWritesAsync?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "abc" })
    expect(f.deltas().map(({ delta, offset }) => [delta, offset])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ])
  } finally {
    await f.close()
  }
})

test("a failed rebased batch retries all its text after a later part insertion aborts", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "c" })
    if (!f.store.appendParts) throw new Error("Compact store missing")
    f.store.appendParts({
      threadId: "t",
      messageId: "reply",
      parts: [{ partIndex: 1, part: { type: "reasoning", text: "Pensando" } }],
    })
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "d" })
    f.appendFromSecondConnection("b", 0)
    f.database.exec(`CREATE TRIGGER reject_stream_part BEFORE INSERT ON transcript_entries
      WHEN json_extract(NEW.event_json, '$.type') = 'message.parts'
      BEGIN SELECT RAISE(ABORT, 'retry part'); END`)
    f.store.flushWrites?.()
    await Bun.sleep(20)
    expect(f.deltas().map(({ delta }) => delta)).toEqual(["b"])
    f.database.exec("DROP TRIGGER reject_stream_part")
    await f.store.flushWritesAsync?.()
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "bcd" })
    expect(f.deltas().map(({ delta, offset }) => [delta, offset])).toEqual([
      ["b", 0],
      ["c", 1],
      ["d", 2],
    ])
    expect(f.store.activePath({ threadId: "t", leafId: "reply" })[0]?.parts[1]).toMatchObject({ text: "Pensando" })
  } finally {
    f.database.exec("DROP TRIGGER IF EXISTS reject_stream_part")
    await f.close()
  }
})

test("the timer recovers previously accepted text after a reader's outer transaction rolls back", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "fora" })
    expect(() =>
      f.database.transaction(() => {
        expect(f.store.activePath({ threadId: "t", leafId: "reply" })[0]?.text).toBe("fora")
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    await Bun.sleep(STREAM_WRITE_LIMITS.delayMs * 3 + 30)
    expect(
      f
        .deltas()
        .map(({ delta }) => delta)
        .join(""),
    ).toBe("fora")
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "fora" })
  } finally {
    await f.close()
  }
})

test("the timer retries accepted text rejected by a generation change that later rolls back", async () => {
  const f = await fixture()
  try {
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "fora" })
    expect(() =>
      f.database.transaction(() => {
        f.database.exec("UPDATE threads SET generation = generation + 1 WHERE id = 't'")
        f.store.activePath({ threadId: "t", leafId: "reply" })
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    await Bun.sleep(STREAM_WRITE_LIMITS.delayMs * 3 + 30)
    expect(
      f
        .deltas()
        .map(({ delta }) => delta)
        .join(""),
    ).toBe("fora")
    expect(f.database.query("SELECT COUNT(*) AS n FROM rejections").get()).toEqual({ n: 0 })
    materializeTranscript(f.database)
    expect(f.database.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "fora" })
  } finally {
    await f.close()
  }
})
