import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import initialSql from "../../src/kernel/migrations/0001.sql" with { type: "text" }
import notificationsSql from "../../src/kernel/migrations/0002.sql" with { type: "text" }
import workspaceSql from "../../src/kernel/migrations/0021.sql" with { type: "text" }
import { backfillWorkspaceAttentionBatch } from "../../src/kernel/workspace-attention-backfill"

const databases = new Set<Database>()

afterEach(() => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
})

test("workspace projection backfills attention parts in bounded batches and follows edits and deletion", () => {
  const db = new Database(":memory:")
  databases.add(db)
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(initialSql)
  db.exec(notificationsSql)
  db.exec(`ALTER TABLE threads ADD COLUMN group_thread_id TEXT;
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Bot','codex','/tmp/bot',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Chat',1,1);`)

  const parts = [
    { type: "tool_call", outputJson: "output ".repeat(1000) },
    { type: "notice", text: "Notice" },
    { type: "approval", approvalId: "request", decision: "pending" },
    { type: "notice", text: "Another notice" },
  ]
  db.query(`INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES ('message','thread','assistant','approval','complete',?,1,1)`).run(JSON.stringify(parts))
  db.query(`INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES ('older-one','thread','assistant','text','complete','[]',2,2),
      ('older-two','thread','assistant','text','complete','[]',3,3)`).run()
  db.exec(workspaceSql)

  const projected = () =>
    db.query("SELECT part_index, type, decision FROM workspace_message_attention ORDER BY part_index").all()
  expect(backfillWorkspaceAttentionBatch(db, 2, () => 0)).toEqual({ done: false, processed: 2 })
  expect(projected()).toEqual([])
  expect(backfillWorkspaceAttentionBatch(db, 2, () => 0)).toEqual({ done: false, processed: 1 })
  expect(projected()).toEqual([
    { part_index: 1, type: "notice", decision: null },
    { part_index: 2, type: "approval", decision: "pending" },
    { part_index: 3, type: "notice", decision: null },
  ])
  expect(backfillWorkspaceAttentionBatch(db, 2, () => 0)).toEqual({ done: true, processed: 0 })

  // Reapplying the guarded asset cannot duplicate projections or triggers.
  db.exec(workspaceSql)
  expect(projected()).toHaveLength(3)
  db.query("UPDATE messages SET parts_json = ? WHERE id = 'message'").run(
    JSON.stringify([{ ...parts[2], decision: "approved" }]),
  )
  expect(projected()).toEqual([{ part_index: 0, type: "approval", decision: "approved" }])
  db.exec("UPDATE messages SET parts_json = '[]' WHERE id = 'message'")
  expect(projected()).toEqual([])
  db.query("UPDATE messages SET parts_json = ? WHERE id = 'message'").run(JSON.stringify(parts))
  db.exec("DELETE FROM messages WHERE id = 'message'")
  expect(projected()).toEqual([])
  expect(
    (db.query("SELECT value FROM schema_meta WHERE key='workspace_activity_version'").get() as { value: string }).value,
  ).toBe("1")
})
