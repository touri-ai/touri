import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import {
  backfillWorkspaceAttentionBatch,
  startWorkspaceAttentionBackfill,
} from "../../src/kernel/workspace-attention-backfill"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  const pending = Array.from(cleanups).reduce<Array<() => void | Promise<void>>>(
    (tasks, task) => [task].concat(tasks),
    [],
  )
  for (const cleanup of pending) await cleanup()
  cleanups.clear()
})

test("the attention backfill yields after its processing budget and commits only the processed cursor", async () => {
  const { database } = await getFixture()
  let elapsed = 0
  const now = () => {
    elapsed += 8
    return elapsed
  }

  const result = backfillWorkspaceAttentionBatch(database, 50, now)

  expect(result).toEqual({ done: false, processed: 1 })
  expect(database.query("SELECT cursor FROM workspace_attention_backfill WHERE id = 1").get()).toEqual({ cursor: 2 })
  expect(database.query("SELECT message_id FROM workspace_message_attention").all()).toEqual([
    { message_id: "message-3" },
  ])
})

test("the attention cursor resumes after reopening without replacing a live edit or deleted message", async () => {
  const { database, filename } = await getFixture()
  backfillWorkspaceAttentionBatch(database, 1, () => 0)
  database.query("UPDATE messages SET parts_json = '[]' WHERE id = 'message-2'").run()
  database.query("DELETE FROM messages WHERE id = 'message-1'").run()
  database.close()
  const reopened = openDatabase({ filename })
  cleanups.add(() => reopened.close())

  backfillWorkspaceAttentionBatch(reopened, 50, () => 0)
  const result = backfillWorkspaceAttentionBatch(reopened)

  expect(result.done).toBe(true)
  expect(reopened.query("SELECT message_id FROM workspace_message_attention").all()).toEqual([
    { message_id: "message-3" },
  ])
  expect(reopened.query("SELECT 1 FROM workspace_attention_backfill").get()).toBeNull()
})

test("a locked attention backfill yields, retains its cursor, and resumes after the writer releases", async () => {
  const { database, filename } = await getFixture()
  const writer = new Database(filename)
  cleanups.add(() => writer.close())
  writer.exec("BEGIN IMMEDIATE")
  const errors = new Set<unknown>()
  const stop = startWorkspaceAttentionBackfill(database, (error) => errors.add(error))
  cleanups.add(stop)
  const started = performance.now()

  await Bun.sleep(100)

  expect(performance.now() - started).toBeLessThan(1000)
  expect(database.query("SELECT cursor FROM workspace_attention_backfill WHERE id = 1").get()).toEqual({ cursor: 3 })
  expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
  expect(errors.size).toBe(0)
  writer.exec("ROLLBACK")

  await getEventually(() => !database.query("SELECT 1 FROM workspace_attention_backfill").get())

  expect(database.query("SELECT message_id FROM workspace_message_attention").all()).toHaveLength(3)
})

test("a large historical body is processed outside the request event loop", async () => {
  const { database } = await getFixture()
  const parts = JSON.stringify([
    { type: "tool_call", outputJson: "x".repeat(64 * 1024 * 1024) },
    { type: "approval", approvalId: "synthetic-request", decision: "pending" },
  ])
  database.exec("DROP TRIGGER workspace_attention_update")
  database.query("UPDATE messages SET parts_json = ? WHERE id = 'message-3'").run(parts)
  const errors = new Set<unknown>()
  const stop = startWorkspaceAttentionBackfill(database, (error) => errors.add(error))
  cleanups.add(stop)
  const started = performance.now()

  await Bun.sleep(100)

  expect(performance.now() - started).toBeLessThan(200)
  const writeStarted = performance.now()
  database.query("INSERT INTO settings(key,value_json,updated_at) VALUES ('synthetic.concurrent','true',1)").run()
  expect(performance.now() - writeStarted).toBeLessThan(200)
  await stop()
  const resume = startWorkspaceAttentionBackfill(database, (error) => errors.add(error))
  cleanups.add(resume)

  await getEventually(() => !database.query("SELECT 1 FROM workspace_attention_backfill").get(), 10_000)
  expect(database.query("SELECT message_id FROM workspace_message_attention").all()).toHaveLength(3)
  expect(errors.size).toBe(0)
}, 20_000)

test("stopping attention backfill before its first batch preserves durable progress", async () => {
  const { database } = await getFixture()
  const errors = new Set<unknown>()
  const stop = startWorkspaceAttentionBackfill(database, (error) => errors.add(error))
  cleanups.add(stop)

  await stop()
  await Bun.sleep(50)

  expect(database.query("SELECT cursor FROM workspace_attention_backfill WHERE id = 1").get()).toEqual({ cursor: 3 })
  expect(database.query("SELECT message_id FROM workspace_message_attention").all()).toEqual([])
  expect(errors.size).toBe(0)
})

test("an idle kernel releases its database synchronously during shutdown", async () => {
  const { database, root } = await getFixture()
  database.exec("DELETE FROM workspace_attention_backfill")
  database.close()
  const runtime = createKernel({ appData: root })
  cleanups.add(() => runtime.stop())
  const db = runtime.kernel.db as Database

  const stopped = runtime.stop()

  expect(() => db.query("SELECT 1").get()).toThrow()
  await stopped
})

test("connected workspace clients receive a refresh after historical attention becomes available", async () => {
  const { database, root } = await getFixture()
  database.close()
  const runtime = createKernel({ appData: root })
  cleanups.add(() => runtime.stop())
  const refreshes = new Set<number>()
  const unsubscribe = runtime.kernel.subscribe(({ event, seq }) => {
    if (event.type === "transcript.resync") refreshes.add(seq)
  })
  cleanups.add(unsubscribe)

  await getEventually(() => refreshes.size > 0)

  expect(refreshes.size).toBe(1)
  const db = runtime.kernel.db as Database
  expect(db.query("SELECT message_id FROM workspace_message_attention").all()).toHaveLength(3)
  expect(db.query("SELECT 1 FROM workspace_attention_backfill").get()).toBeNull()
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-attention-backfill-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, "touri.db")
  const database = openDatabase({ filename })
  cleanups.add(() => database.close())
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic','codex','.',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);`)
  const parts = JSON.stringify([{ type: "approval", approvalId: "synthetic-request", decision: "pending" }])
  const insert = database.query(`INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES (?,'thread','assistant','approval','complete',?,1,1)`)
  Array.from({ length: 3 }, (_, index) => index + 1).forEach((index) => {
    insert.run(`message-${index}`, parts)
  })
  database.exec(
    "DELETE FROM workspace_message_attention; INSERT INTO workspace_attention_backfill(id,cursor) VALUES (1,3)",
  )

  return { root, filename, database }
}

const getEventually = async (isReady: () => boolean, timeoutMs = 1000) => {
  const deadline = performance.now() + timeoutMs
  while (!isReady() && performance.now() < deadline) await Bun.sleep(10)

  expect(isReady()).toBe(true)
}
