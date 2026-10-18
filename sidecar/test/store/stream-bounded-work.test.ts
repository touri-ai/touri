import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import { createStreamWriter } from "../../src/store/stream-writer"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test.each([128, 8_192])("patching one part never serializes or traverses %i historical parts", async (count) => {
  const fixture = await getFixture(count)
  const stringify = spyOn(JSON, "stringify")
  cleanups.add(() => {
    stringify.mockRestore()
  })

  fixture.store.appendParts?.({
    threadId: "thread",
    messageId: "reply",
    parts: [{ partIndex: count, part: getTool("updated") }],
  })
  fixture.store.flushWrites?.()
  const serializedParts = stringify.mock.calls.filter(
    ([value]) => typeof value === "object" && value !== null && "type" in value && value.type === "tool_call",
  )
  const message = fixture.store.activePath({ threadId: "thread", leafId: "reply" })[0]

  expect(serializedParts.length).toBeLessThanOrEqual(2)
  expect(fixture.getHistoricalReads()).toBe(0)
  expect(message?.parts).toHaveLength(count + 1)
  expect(message?.parts[count]).toMatchObject({ outputJson: "updated" })
})

test("a legacy prefix of tiny inline results does not become a bulk file rewrite on its first patch", async () => {
  const count = 8_192
  const fixture = await getFixture(count, "x", false)
  const stringify = spyOn(JSON, "stringify")
  cleanups.add(() => {
    stringify.mockRestore()
  })

  fixture.store.appendParts?.({
    threadId: "thread",
    messageId: "reply",
    parts: [{ partIndex: count, part: getTool("updated") }],
  })
  fixture.store.flushWrites?.()
  const serializedParts = stringify.mock.calls.filter(
    ([value]) => typeof value === "object" && value !== null && "type" in value && value.type === "tool_call",
  )
  const message = fixture.store.activePath({ threadId: "thread", leafId: "reply" })[0]

  expect(serializedParts.length).toBeLessThanOrEqual(2)
  expect(fixture.getAttachmentCount()).toBeLessThanOrEqual(1)
  expect(message?.parts.slice(0, count)).toEqual(
    Array.from({ length: count }, (_, index) => getTool(`history-${index}`, "x")),
  )
})

const getFixture = async (count: number, historicalOutput: string | null = null, warm = true) => {
  const root = await mkdtemp(join(tmpdir(), "touri-bounded-stream-"))
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

  let historicalReads = 0
  const history = Array.from({ length: count }, (_, index) => getTool(`history-${index}`, historicalOutput))
  const parts = history.concat(getTool("initial"))
  const insert = store.insertMessage({
    message: {
      id: "reply",
      threadId: "thread",
      parentId: null,
      role: "assistant",
      kind: "text",
      status: "streaming",
      runId: null,
      text: "",
      parts,
      sender: null,
      source: "local",
    },
  })
  if (!insert.success) throw new Error("Fixture insert failed")

  // Warm the live projection, then count reads of retired parts through its original array.
  const getMessage = () =>
    Object.assign({}, insert.message, {
      parts: new Proxy(insert.message.parts, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property) && Number(property) < count) historicalReads += 1

          return Reflect.get(target, property, receiver)
        },
      }),
    })
  const writer = createStreamWriter({ kernel: runtime.kernel, database, getMessage, getThread: store.getThread })
  if (warm) {
    writer.appendParts({ threadId: "thread", messageId: "reply", parts: [{ partIndex: count, part: getTool("warm") }] })
    writer.drain()
  }
  historicalReads = 0
  const writerStore = Object.assign({}, store, { appendParts: writer.appendParts, flushWrites: writer.drain })
  cleanups.add(() => {
    writer.drain()
  })

  return {
    store: writerStore,
    getHistoricalReads: () => historicalReads,
    getAttachmentCount: () =>
      (database.query("SELECT count(*) AS count FROM attachments").get() as { count: number }).count,
  }
}

const getTool = (output: string, outputJson: string | null = output): MessagePart => ({
  type: "tool_call",
  callId: output,
  tool: "synthetic_tool",
  summary: "Synthetic result",
  inputJson: "{}",
  outputJson,
  ok: true,
})
