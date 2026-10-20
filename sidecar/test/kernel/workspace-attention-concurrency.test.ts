import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { backfillWorkspaceAttentionBatch } from "../../src/kernel/workspace-attention-backfill"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  const pending = Array.from(cleanups).reduce<Array<() => void | Promise<void>>>(
    (tasks, task) => [task].concat(tasks),
    [],
  )
  for (const cleanup of pending) await cleanup()
  cleanups.clear()
})

test("a concurrent approval edit invalidates prepared history before projection writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-attention-concurrent-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, "touri.db")
  const database = openDatabase({ filename })
  cleanups.add(() => database.close())
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic','codex','.',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES ('older','thread','assistant','text','complete','[]',1,1),
      ('approval','thread','assistant','approval','complete',
        '[{"type":"approval","approvalId":"synthetic","decision":"pending"}]',2,2);
    DELETE FROM workspace_message_attention;
    INSERT INTO workspace_attention_backfill(id,cursor) VALUES (1,2)`)
  const writer = new Database(filename)
  cleanups.add(() => writer.close())
  // The injected clock pauses preparation after its first row, before any write lock.
  let clockCalls = 0
  const now = () => {
    clockCalls += 1
    if (clockCalls === 2) writer.query("UPDATE messages SET parts_json = '[]' WHERE id = 'approval'").run()
    return 0
  }

  const stale = backfillWorkspaceAttentionBatch(database, 50, now)

  expect(stale).toEqual({ done: false, processed: 0 })
  expect(database.query("SELECT cursor FROM workspace_attention_backfill WHERE id = 1").get()).toEqual({ cursor: 2 })
  expect(database.query("SELECT 1 FROM workspace_message_attention").get()).toBeNull()

  backfillWorkspaceAttentionBatch(database, 50, () => 0)
  const completed = backfillWorkspaceAttentionBatch(database)

  expect(completed.done).toBe(true)
  expect(database.query("SELECT 1 FROM workspace_message_attention").get()).toBeNull()
  expect(database.query("SELECT parts_json FROM messages WHERE id = 'approval'").get()).toEqual({ parts_json: "[]" })
})
