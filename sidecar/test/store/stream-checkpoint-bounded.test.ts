import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { compactTranscript, materializeTranscriptBatch } from "../../src/kernel/transcript-storage"
import { init as initStore } from "../../src/store"
import { createStreamWriter, STREAM_WRITE_LIMITS } from "../../src/store/stream-writer"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("a periodic checkpoint materializes only one concurrent reply", async () => {
  const fixture = await getFixture()
  fixture.writer.appendDelta({ threadId: "thread", messageId: "first", partIndex: 0, delta: "first" })
  fixture.writer.appendDelta({ threadId: "thread", messageId: "second", partIndex: 0, delta: "second" })

  fixture.advance()
  fixture.writer.flush()
  const deltas = fixture.database
    .query("SELECT count(*) AS n FROM transcript_entries WHERE event_json LIKE '%message.delta%'")
    .get()

  expect(fixture.getPending()).toBe(1)
  expect(fixture.getTexts()).toEqual(["first", ""])
  expect(deltas).toEqual({ n: 2 })
})

test("periodic checkpoints rotate replies and preserve subsequent delta offsets", async () => {
  const fixture = await getFixture()
  fixture.writer.appendDelta({ threadId: "thread", messageId: "first", partIndex: 0, delta: "first" })
  fixture.writer.appendDelta({ threadId: "thread", messageId: "second", partIndex: 0, delta: "second" })
  fixture.advance()
  fixture.writer.flush()

  fixture.writer.appendDelta({ threadId: "thread", messageId: "first", partIndex: 0, delta: " more" })
  fixture.writer.appendDelta({ threadId: "thread", messageId: "second", partIndex: 0, delta: " more" })
  fixture.advance()
  fixture.writer.flush()

  expect(fixture.getPending()).toBe(1)
  expect(fixture.getTexts()).toEqual(["first", "second more"])

  fixture.writer.checkpoint()

  expect(fixture.getPending()).toBe(0)
  expect(fixture.getTexts()).toEqual(["first more", "second more"])
})

test("a busy periodic checkpoint retries without losing either reply", async () => {
  const fixture = await getFixture()
  fixture.writer.appendDelta({ threadId: "thread", messageId: "first", partIndex: 0, delta: "first" })
  fixture.writer.appendDelta({ threadId: "thread", messageId: "second", partIndex: 0, delta: "second" })
  const blocker = new Database(fixture.database.filename)
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  fixture.advance()

  fixture.writer.flush()

  expect(fixture.getPending()).toBe(0)
  expect(fixture.getTexts()).toEqual(["", ""])

  blocker.exec("ROLLBACK")
  fixture.writer.flush()

  expect(fixture.getPending()).toBe(1)
  expect(fixture.getTexts()).toEqual(["first", ""])

  fixture.writer.checkpoint()

  expect(fixture.getPending()).toBe(0)
  expect(fixture.getTexts()).toEqual(["first", "second"])
})

test("retaining old history does not materialize unrelated live replies", async () => {
  const fixture = await getFixture()
  fixture.writer.appendDelta({ threadId: "thread", messageId: "first", partIndex: 0, delta: "first" })
  fixture.writer.appendDelta({ threadId: "thread", messageId: "second", partIndex: 0, delta: "second" })
  fixture.writer.flush()
  const queries = spyOn(fixture.database, "query")
  cleanups.add(() => {
    queries.mockRestore()
  })

  compactTranscript({ database: fixture.database, entriesPerThread: 4 })
  const statements = queries.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => sql.startsWith("SELECT 1 FROM transcript_pending_deltas p"))
  const plans = statements.flatMap(
    (sql) => fixture.database.query(`EXPLAIN QUERY PLAN ${sql}`).all("thread", 1, 1) as { detail: string }[],
  )

  expect(fixture.getPending()).toBe(2)
  expect(fixture.getTexts()).toEqual(["", ""])
  expect(statements).toHaveLength(2)
  expect(plans.some(({ detail }) => /SCAN (p|m|e|part)\b/.test(detail))).toBe(false)
  console.info(`stream-retention-query-plans ${JSON.stringify(plans)}`)
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-checkpoint-bounded-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1)`)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Fixture store missing")

  const messageIds = ["old", "first", "second"]
  messageIds.forEach((id) => {
    const result = store.insertMessage({ message: getMessage(id) })
    if (!result.success) throw new Error("Fixture message missing")
  })
  let at = 0
  const getStoredMessage = ({ threadId, messageId }: { threadId: string; messageId: string }): Message | null => {
    const row = database
      .query("SELECT payload FROM transcript_message_events WHERE thread_id = ? AND id = ?")
      .get(threadId, messageId) as { payload: string } | null
    if (!row) return null

    return (JSON.parse(row.payload) as { message: Message }).message
  }
  const writer = createStreamWriter({
    kernel: runtime.kernel,
    database,
    getMessage: getStoredMessage,
    getThread: store.getThread,
    getNow: () => at,
  })
  cleanups.add(() => {
    writer.drain()
  })

  return {
    database,
    writer,
    advance: () => {
      at += STREAM_WRITE_LIMITS.checkpointMs + 1
    },
    getPending: () => (database.query("SELECT count(*) AS n FROM transcript_pending_deltas").get() as { n: number }).n,
    getTexts: () =>
      (
        database.query("SELECT text FROM messages WHERE id IN ('first','second') ORDER BY id").all() as {
          text: string
        }[]
      ).map(({ text }) => text),
  }
}

const getMessage = (id: string): Omit<Message, "createdAt" | "updatedAt"> => ({
  id,
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: id === "old" ? "complete" : "streaming",
  runId: null,
  text: "",
  parts: [{ type: "text", text: "" }],
  sender: null,
  source: "local",
})

test("restart recovery checkpoints at most 128 journal entries before yielding", async () => {
  const fixture = await getFixture()
  const insert = fixture.database.query(`INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at)
    VALUES ('thread',?,1,?,1)`)
  fixture.database.transaction(() => {
    Array.from({ length: 300 }, (_, index) => index).forEach((index) => {
      insert.run(
        1000 + index,
        JSON.stringify({
          type: "message.delta",
          threadId: "thread",
          messageId: "first",
          partIndex: 0,
          offset: index,
          delta: "x",
        }),
      )
    })
    fixture.database.exec(
      "INSERT OR IGNORE INTO transcript_pending_deltas(thread_id,message_id) VALUES ('thread','first')",
    )
  })()

  const pending = materializeTranscriptBatch(fixture.database)
  const first = fixture.getTexts()[0]
  while (materializeTranscriptBatch(fixture.database)) await Bun.sleep(0)

  expect(pending).toBe(true)
  // The bounded window can also contain entries for another message.
  expect(first?.length).toBeGreaterThan(0)
  expect(first?.length).toBeLessThanOrEqual(128)
  expect(fixture.getTexts()[0]).toBe("x".repeat(300))
  expect(fixture.getPending()).toBe(0)
})

test("retention seeks history for at most one thread per periodic pass", async () => {
  const fixture = await getFixture()
  fixture.database.transaction(() => {
    const insert = fixture.database.query(`INSERT INTO threads(id,bot_id,title,created_at,updated_at,updated_seq)
      VALUES (?,'bot','Synthetic',1,1,5000)`)
    Array.from({ length: 200 }, (_, index) => index).forEach((index) => {
      insert.run(`history-${index}`)
    })
  })()
  const queries = spyOn(fixture.database, "query")
  cleanups.add(() => {
    queries.mockRestore()
  })

  const more = compactTranscript({ database: fixture.database, maxAgeMs: Number.MAX_SAFE_INTEGER })
  const reverseSeeks = queries.mock.calls.filter(([sql]) =>
    sql.includes("WHERE thread_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?"),
  )

  expect(more).toBe(true)
  expect(reverseSeeks.length).toBeLessThanOrEqual(1)
  expect(fixture.database.query("SELECT COUNT(*) AS n FROM threads").get()).toEqual({ n: 201 })
})
