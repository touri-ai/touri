import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import baseSql from "../../src/kernel/migrations/0001.sql" with { type: "text" }
import notificationsSql from "../../src/kernel/migrations/0002.sql" with { type: "text" }
import avatarsSql from "../../src/kernel/migrations/0003.sql" with { type: "text" }
import machinesSql from "../../src/kernel/migrations/0004.sql" with { type: "text" }
import rolesSql from "../../src/kernel/migrations/0005.sql" with { type: "text" }
import mcpServersSql from "../../src/kernel/migrations/0006.sql" with { type: "text" }
import { createPerformanceStageTracker } from "../../src/kernel/performance"
import { createSlowStatementTracker } from "../../src/kernel/sqlite-performance"
import { backfillWorkspaceAttentionBatch } from "../../src/kernel/workspace-attention-backfill"

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test("legacy message migration validates delivery status without scanning the message table", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-schema-migration-"))
  const filename = join(root, "touri.db")
  let database: Database | undefined
  cleanups.add(() => {
    database?.close()
    rmSync(root, { recursive: true, force: true })
  })

  const legacyDatabase = new Database(filename)
  database = legacyDatabase
  const migrations = [baseSql, notificationsSql, avatarsSql, machinesSql, rolesSql, mcpServersSql]
  migrations.forEach((migration) => {
    legacyDatabase.exec(migration)
  })
  legacyDatabase.exec(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Bot','codex','/tmp/bot',1,1)",
  )
  legacyDatabase.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Main',1,1)")
  const insertMessage = legacyDatabase.query(`INSERT INTO messages(
    id,thread_id,parent_id,role,kind,text,parts_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)`)
  const messageIndexes = Array.from({ length: 50_000 }, (_, index) => index)
  legacyDatabase.transaction(() => {
    messageIndexes.forEach((index) => {
      const text = `Synthetic history ${index}`
      insertMessage.run(
        `message-${index}`,
        "thread",
        index ? `message-${index - 1}` : null,
        "assistant",
        "text",
        text,
        JSON.stringify([{ type: "text", text }]),
        index + 1,
        index + 1,
      )
    })
  })()
  legacyDatabase.close()
  database = undefined
  const legacyDatabaseBytes = statSync(filename).size

  const stages = createPerformanceStageTracker()
  const slowStatements = createSlowStatementTracker({
    log: () => {},
    getStage: stages.getCurrentStage,
    runStage: stages.run,
    thresholdMs: 20,
  })
  const started = performance.now()
  const migratedDatabase = openDatabase({ filename, slowStatements, runStage: stages.run })
  database = migratedDatabase
  const migrationMs = performance.now() - started
  const attentionBatch = stages.run("workspace_attention_backfill", () =>
    backfillWorkspaceAttentionBatch(migratedDatabase),
  )

  const messageSchema = migratedDatabase
    .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'messages'")
    .get() as { sql: string }
  const checkConstraintsIgnored = migratedDatabase.query("PRAGMA ignore_check_constraints").get() as {
    ignore_check_constraints: number
  }
  const migratedStages = stages.snapshot().map((timing) => timing.stage)
  const schemaStage = stages.snapshot().find((timing) => timing.stage === "schema_migration")
  const attentionStage = stages.snapshot().find((timing) => timing.stage === "workspace_attention_backfill")
  const slowestStatements = slowStatements
    .snapshot()
    .reduce<Array<{ stage: string; maxMs: number; sql: string }>>((entries, statement) => {
      const item = { stage: statement.stage, maxMs: statement.maxMs, sql: statement.sql }
      const index = entries.findIndex((entry) => item.maxMs > entry.maxMs)
      if (index < 0) {
        if (entries.length >= 5) return entries
        return entries.concat(item)
      }

      return entries.slice(0, index).concat(item, entries.slice(index)).slice(0, 5)
    }, [])

  expect(messageSchema.sql).toMatch(/delivery_status\s+TEXT\s+CHECK/i)
  expect(checkConstraintsIgnored.ignore_check_constraints).toBe(0)
  expect(() =>
    migratedDatabase
      .query("UPDATE messages SET delivery_status = ? WHERE thread_id = ? AND id = ?")
      .run("invalid", "thread", "message-0"),
  ).toThrow()
  expect(() =>
    migratedDatabase
      .query(`INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at,delivery_status)
      VALUES ('invalid','thread','assistant','text','Synthetic','[]',1,1,'invalid')`)
      .run(),
  ).toThrow()
  migratedDatabase
    .query("UPDATE messages SET delivery_status = ? WHERE thread_id = ? AND id = ?")
    .run("sent", "thread", "message-0")
  expect(migratedDatabase.query("SELECT delivery_status FROM messages WHERE id = 'message-0'").get()).toEqual({
    delivery_status: "sent",
  })
  expect(migratedStages).toContain("schema_migration")
  expect(migratedStages).toContain("workspace_attention_backfill")
  expect(attentionBatch.processed).toBeLessThanOrEqual(50)
  console.info(
    `50k legacy schema (${(legacyDatabaseBytes / (1024 * 1024)).toFixed(1)} MiB): ${migrationMs.toFixed(1)} ms; ` +
      `schema stage ${schemaStage?.maxMs.toFixed(1)} ms; ` +
      `attention batch ${attentionStage?.maxMs.toFixed(1)} ms (${attentionBatch.processed} rows); ` +
      `slow statements ${JSON.stringify(slowestStatements)}`,
  )
})
