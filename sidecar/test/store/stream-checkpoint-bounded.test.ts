import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { compactTranscript } from "../../src/kernel/transcript-storage"
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
