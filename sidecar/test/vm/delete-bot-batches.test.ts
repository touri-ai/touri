import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { deleteBotWorkerSource } from "../../src/vm/delete-bot-worker"

type Batch = { phase: string; processed: number }
const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("bounded deletion transactions avoid writing every dirty page again for each message", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-deletion-batches-"))
  const database = openDatabase({ filename: join(root, "history.sqlite") })
  const url = URL.createObjectURL(new Blob([deleteBotWorkerSource], { type: "application/javascript" }))
  const worker = new Worker(url)
  cleanups.add(async () => {
    worker.terminate()
    URL.revokeObjectURL(url)
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('bot','Synthetic','codex','/tmp/synthetic',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 256)
    INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at)
      SELECT 'message-' || id,'thread','assistant','text','Synthetic','[]',1,1 FROM ids;
    INSERT INTO bot_deletions(bot_id,delete_volumes,phase,created_at,updated_at)
      VALUES ('bot',0,'messages',1,1);
    PRAGMA wal_checkpoint(TRUNCATE);`)
  const ready = Promise.withResolvers<void>()
  const replies = new Map<string, ReturnType<typeof Promise.withResolvers<Batch>>>()
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") ready.resolve()
    if (data.type === "startup-error") ready.reject(new Error("Deletion worker did not start"))
    if (data.type === "batch") replies.get(data.id)?.resolve(data.result)
    if (data.type === "batch-error") replies.get(data.id)?.reject(new Error("Deletion batch failed"))
  }
  worker.onerror = () => ready.reject(new Error("Deletion worker failed"))
  worker.postMessage({ type: "start", filename: database.filename })
  await ready.promise

  // Accumulate fewer than 128 units, so the worker's normal checkpoint cannot hide write amplification.
  let processed = 0
  for (let id = 0; processed < 32; id++) {
    const reply = Promise.withResolvers<Batch>()
    replies.set(String(id), reply)
    worker.postMessage({ type: "batch", id: String(id), botId: "bot" })
    const result = await reply.promise
    processed = result.processed
  }
  const checkpoint = database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy: number; log: number }

  console.info(`bot-deletion-write-amplification ${JSON.stringify({ processed, frames: checkpoint.log })}`)
  expect(checkpoint.busy).toBe(0)
  expect(checkpoint.log).toBeLessThan(processed * 4)
  expect(database.query("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 256 - processed })
})
