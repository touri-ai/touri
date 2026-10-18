import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { backfillHistoryBatch, historyMigrationStatus, hydrateHistoryEvent } from "../../src/kernel/history-backfill"
import { legacySourceRebuild } from "../../src/kernel/legacySourceRebuild"
import baseSql from "../../src/kernel/migrations/0001.sql" with { type: "text" }
import notificationsSql from "../../src/kernel/migrations/0002.sql" with { type: "text" }
import avatarsSql from "../../src/kernel/migrations/0003.sql" with { type: "text" }
import machinesSql from "../../src/kernel/migrations/0004.sql" with { type: "text" }
import rolesSql from "../../src/kernel/migrations/0005.sql" with { type: "text" }
import serversSql from "../../src/kernel/migrations/0006.sql" with { type: "text" }
import transcriptSql from "../../src/kernel/migrations/0007.sql" with { type: "text" }
import groupsSql from "../../src/kernel/migrations/0008.sql" with { type: "text" }
import cloudSql from "../../src/kernel/migrations/0009.sql" with { type: "text" }
import recoverySql from "../../src/kernel/migrations/0010.sql" with { type: "text" }
import reportsSql from "../../src/kernel/migrations/0011.sql" with { type: "text" }
import opencodeSql from "../../src/kernel/migrations/0012.sql" with { type: "text" }
import workRecoverySql from "../../src/kernel/migrations/0013.sql" with { type: "text" }
import legacySourceSql from "../../src/kernel/migrations/0014.sql" with { type: "text" }
import continuationsSql from "../../src/kernel/migrations/0015.sql" with { type: "text" }
import botFoldersSql from "../../src/kernel/migrations/0016.sql" with { type: "text" }
import providerProfilesSql from "../../src/kernel/migrations/0017.sql" with { type: "text" }
import permissionContinuationsSql from "../../src/kernel/migrations/0018.sql" with { type: "text" }
import botBrowserSql from "../../src/kernel/migrations/0019.sql" with { type: "text" }
import responseActivitySql from "../../src/kernel/migrations/0020.sql" with { type: "text" }
import workspaceSql from "../../src/kernel/migrations/0021.sql" with { type: "text" }
import boundedHistorySql from "../../src/kernel/migrations/0022.sql" with { type: "text" }
import streamWriterSql from "../../src/kernel/migrations/0023.sql" with { type: "text" }
import groupRoutinesSql from "../../src/kernel/migrations/0024.sql" with { type: "text" }
import goalsSql from "../../src/kernel/migrations/0025.sql" with { type: "text" }
import recoveryCenterSql from "../../src/kernel/migrations/0026.sql" with { type: "text" }
import messageSearchSql from "../../src/kernel/migrations/0027.sql" with { type: "text" }
import groupDeletionSql from "../../src/kernel/migrations/0028.sql" with { type: "text" }
import computerGrantExpirySql from "../../src/kernel/migrations/0029.sql" with { type: "text" }
import { TRANSCRIPT_RETENTION } from "../../src/kernel/transcript-storage"
import { init as initStore } from "../../src/store"

const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
const legacyDatabase = (root: string, threads = 4, rows = 150, repeats = 100): number => {
  const filename = join(root, "touri.db")
  const database = new Database(filename)
  for (const sql of [baseSql, notificationsSql, avatarsSql, machinesSql, rolesSql, serversSql]) database.exec(sql)
  const timestamp = Date.now()
  database.exec(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1)",
  )
  const insert = database.query(
    "INSERT INTO messages(id,thread_id,parent_id,role,kind,text,parts_json,created_at,updated_at) VALUES (?, ?, ?, 'assistant','text', ?, ?, ?, ?)",
  )
  database.transaction(() => {
    for (let thread = 0; thread < threads; thread++) {
      database
        .query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?, 'b','Histórico',1,1)")
        .run(`t${thread}`)
      for (let row = 0; row < rows; row++) {
        const text = `${thread}/${row}: ${"Histórico preservado. ".repeat(repeats)}`
        insert.run(
          `m${row}`,
          `t${thread}`,
          row ? `m${row - 1}` : null,
          text,
          JSON.stringify([{ type: "text", text }]),
          timestamp + row,
          timestamp + row,
        )
      }
      database.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(`m${rows - 1}`, `t${thread}`)
    }
  })()
  database.close()
  return statSync(filename).size
}

test("50k legacy rows serve before backfill, yield between bounded transactions and resume after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-migration-50k-"))
  let runtime: ReturnType<typeof createKernel> | undefined
  let database: Database | undefined
  try {
    const before = legacyDatabase(root, 1, 50_000, 1)
    const started = performance.now()
    runtime = createKernel({ appData: root })
    database = runtime.kernel.db as Database
    expect(historyMigrationStatus(database)).toEqual({ running: true, done: 0, total: 50_000 })
    const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1/health`
    const health = await (await fetch(url, { headers })).json()
    expect(health.historyMigration.total).toBe(50_000)
    const healthMs = performance.now() - started
    expect(healthMs).toBeLessThan(2000)
    const deadline = Date.now() + 5000
    while (!historyMigrationStatus(database).done && Date.now() < deadline) await Bun.sleep(10)
    const progress = historyMigrationStatus(database)
    expect(progress.done).toBeGreaterThan(0)
    expect(progress.done).toBeLessThan(50_000)
    runtime.stop()
    runtime = undefined
    database = openDatabase({ filename: join(root, "touri.db") })
    expect(historyMigrationStatus(database)).toEqual(progress)
    let previous = progress.done
    let passes = 0
    while (historyMigrationStatus(database).running && passes < 2000) {
      const next = backfillHistoryBatch(database)
      expect(next.done - previous).toBeLessThanOrEqual(500)
      expect(next.done).toBeGreaterThanOrEqual(previous)
      previous = next.done
      passes += 1
    }
    expect(backfillHistoryBatch(database)).toEqual({ running: false, done: 50_000, total: 50_000 })
    expect(database.query("SELECT COUNT(*) AS n, MIN(seq) AS first, MAX(seq) AS last FROM messages").get()).toEqual({
      n: 50_000,
      first: 1,
      last: 50_000,
    })
    expect(database.query("SELECT COUNT(DISTINCT seq) AS n FROM messages").get()).toEqual({ n: 50_000 })
    expect(database.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: 0 })
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const after = statSync(join(root, "touri.db")).size
    expect(after / before).toBeLessThan(1.6)
    console.info(
      `50k history: health ${Math.round(healthMs)} ms; ${before} → ${after} bytes (${(after / before).toFixed(2)}x)`,
    )
  } finally {
    if (runtime) runtime.stop()
    else database?.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("schema 11 answers health in under a second while a 2–5 MB history is backfilled without historical UI events", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-background-migration-"))
  let runtime: ReturnType<typeof createKernel> | undefined
  try {
    const before = legacyDatabase(root)
    expect(before).toBeGreaterThan(2_000_000)
    expect(before).toBeLessThan(5_000_000)
    const started = performance.now()
    runtime = createKernel({ appData: root })
    await initStore(runtime.kernel)
    const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1`
    const health = await (await fetch(`${url}/health`, { headers })).json()
    const healthMs = performance.now() - started
    expect(healthMs).toBeLessThan(1000)
    expect(health).toMatchObject({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      historyMigration: { running: true, total: 600 },
    })
    const snapshot = await (await fetch(`${url}/threads/t3/messages`, { headers })).json()
    expect(snapshot.messages).toHaveLength(150)
    expect(snapshot.messages[0].text).toContain("3/0: Histórico preservado.")
    let done = health
    const deadline = Date.now() + 10_000
    while (done.historyMigration.running && Date.now() < deadline) {
      await Bun.sleep(20)
      const previous = done.historyMigration.done
      const requestStarted = performance.now()
      done = await (await fetch(`${url}/health`, { headers })).json()
      expect(performance.now() - requestStarted).toBeLessThan(1000)
      expect(done.historyMigration.done).toBeGreaterThanOrEqual(previous)
    }
    expect(done.historyMigration).toEqual({ running: false, done: 600, total: 600 })
    const database = runtime.kernel.db as Database
    expect(database.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: 0 })
    expect(database.query("SELECT MAX(length(event_json)) AS n FROM transcript_entries").get()).toMatchObject({
      n: expect.any(Number),
    })
    expect(
      (database.query("SELECT MAX(length(event_json)) AS n FROM transcript_entries").get() as { n: number }).n,
    ).toBeLessThan(200)
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const after = statSync(join(root, "touri.db")).size
    expect(after / before).toBeLessThan(1.6)
    console.info(
      `History backfill: health ${Math.round(healthMs)} ms; ${before} → ${after} bytes (${(after / before).toFixed(2)}x)`,
    )
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  } finally {
    runtime?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("interrupted batches resume idempotently and match the shipped synchronous message projection and transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-migration-resume-"))
  let database: Database | undefined
  let synchronous: Database | undefined
  try {
    const before = legacyDatabase(root)
    const filename = join(root, "touri.db")
    const oldFilename = join(root, "synchronous.db")
    copyFileSync(filename, oldFilename)
    synchronous = new Database(oldFilename)
    synchronous.exec(transcriptSql)
    synchronous.exec(groupsSql)
    synchronous.exec(cloudSql)
    synchronous.exec(recoverySql)
    synchronous.exec(reportsSql)
    synchronous.exec("PRAGMA foreign_keys = OFF")
    synchronous.transaction(() => synchronous?.exec(opencodeSql))()
    synchronous.exec("PRAGMA foreign_keys = ON")
    synchronous.exec(workRecoverySql)
    synchronous.exec("PRAGMA foreign_keys = OFF")
    synchronous.transaction(() => {
      legacySourceRebuild({ database: synchronous as Database })
      synchronous?.exec(legacySourceSql)
    })()
    synchronous.exec("PRAGMA foreign_keys = ON")
    synchronous.exec(continuationsSql)
    synchronous.exec(botFoldersSql)
    synchronous.exec(providerProfilesSql)
    synchronous.exec(permissionContinuationsSql)
    synchronous.exec(botBrowserSql)
    synchronous.exec(responseActivitySql)
    synchronous.exec(workspaceSql)
    synchronous.exec(boundedHistorySql)
    synchronous.exec(streamWriterSql)
    synchronous.exec(groupRoutinesSql)
    synchronous.exec(goalsSql)
    synchronous.exec(recoveryCenterSql)
    synchronous.exec(messageSearchSql)
    synchronous.exec(groupDeletionSql)
    synchronous.exec(computerGrantExpirySql)
    database = openDatabase({ filename })
    expect(database.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(
      synchronous.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
    )
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 0 })
    while (historyMigrationStatus(database).done < 31)
      backfillHistoryBatch(database, 31 - historyMigrationStatus(database).done)
    const first = historyMigrationStatus(database)
    expect(first).toEqual({ running: true, done: 31, total: 600 })
    database.close()
    database = openDatabase({ filename })
    expect(historyMigrationStatus(database)).toEqual(first)
    // An interruption inside a batch must roll back both rows and the marker.
    database.exec(`CREATE TRIGGER interrupt_batch BEFORE UPDATE OF seq ON messages
      WHEN NEW.id = 'm33' BEGIN SELECT RAISE(ABORT, 'quit mid-batch'); END`)
    const resumed = database
    const resumeUntilWrite = () => {
      for (let pass = 0; pass < 100; pass++) backfillHistoryBatch(resumed, 8)
    }
    expect(resumeUntilWrite).toThrow("quit mid-batch")
    expect(historyMigrationStatus(database)).toEqual(first)
    expect(database.query("SELECT COUNT(*) AS n FROM messages WHERE seq > 0").get()).toEqual({ n: 31 })
    database.exec("DROP TRIGGER interrupt_batch")
    while (historyMigrationStatus(database).running) backfillHistoryBatch(database, 17)
    expect(database.query("SELECT * FROM messages ORDER BY thread_id, seq").all()).toEqual(
      synchronous.query("SELECT * FROM messages ORDER BY thread_id, seq").all(),
    )
    expect(database.query("SELECT * FROM threads ORDER BY id").all()).toEqual(
      synchronous.query("SELECT * FROM threads ORDER BY id").all(),
    )
    const entries = database.query("SELECT event_json FROM transcript_entries ORDER BY thread_id, seq").all() as {
      event_json: string
    }[]
    const oldEntries = synchronous.query("SELECT event_json FROM transcript_entries ORDER BY thread_id, seq").all() as {
      event_json: string
    }[]
    expect(entries.map((entry) => hydrateHistoryEvent(database as Database, entry.event_json))).toEqual(
      oldEntries.map((entry) => JSON.parse(entry.event_json)),
    )
    const count = database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()
    backfillHistoryBatch(database)
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual(count)
    const bus = createEventBus(database)
    expect(database.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: 0 })
    bus.stop()
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    const oldBus = createEventBus(synchronous)
    oldBus.stop()
    expect(synchronous.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: 600 })
    console.info(
      `Shipped synchronous path: ${before} → ${statSync(oldFilename).size} bytes (${(statSync(oldFilename).size / before).toFixed(2)}x)`,
    )
  } finally {
    database?.close()
    synchronous?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("live inserts, edits and deltas reserve newer revisions while pending readers resync to legacy rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-migration-live-"))
  let runtime: ReturnType<typeof createKernel> | undefined
  try {
    legacyDatabase(root)
    runtime = createKernel({ appData: root })
    await initStore(runtime.kernel)
    const database = runtime.kernel.db as Database
    const store = runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    store.updateMessage({ threadId: "t3", messageId: "m0", patch: { text: "Editado durante a atualização" } })
    store.insertMessage({
      message: {
        id: "live",
        threadId: "t3",
        parentId: "m149",
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: null,
        text: "",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    store.appendDelta({ threadId: "t3", messageId: "live", partIndex: 0, delta: "Novo conteúdo" })
    const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1/threads/t3`
    const pending = await (await fetch(`${url}/transcript?since=0`, { headers })).json()
    expect(pending).toMatchObject({ resync: true, entries: [], lastSeq: 153 })
    const snapshot = await (await fetch(`${url}/messages`, { headers })).json()
    expect(snapshot.messages[0].text).toBe("Editado durante a atualização")
    // Backfill does not broadcast references even when live publishes cross its IDs.
    backfillHistoryBatch(database, 4)
    runtime.kernel.publish({ type: "import.progress", importId: "live", phase: "done", done: 1, total: 1 })
    while (historyMigrationStatus(database).running) backfillHistoryBatch(database)
    expect(
      database.query("SELECT seq, updated_seq, text FROM messages WHERE thread_id = 't3' AND id = 'm0'").get(),
    ).toEqual({ seq: 1, updated_seq: 151, text: "Editado durante a atualização" })
    expect(
      database.query("SELECT seq, updated_seq, text FROM messages WHERE thread_id = 't3' AND id = 'live'").get(),
    ).toEqual({ seq: 152, updated_seq: 153, text: "Novo conteúdo" })
    expect(
      database.query("SELECT COUNT(*) AS n FROM ui_event_log WHERE json_extract(event_json, '$.legacy') = 1").get(),
    ).toEqual({ n: 0 })
    const transcript = await (await fetch(`${url}/transcript?since=0`, { headers })).json()
    // The live reply's initial pointer was superseded by its text checkpoint.
    // An older cursor refreshes complete snapshots; a current cursor can resume.
    expect(transcript).toMatchObject({ resync: true, entries: [], lastSeq: 153 })
    const resumed = await (await fetch(`${url}/transcript?since=152`, { headers })).json()
    expect(resumed).toMatchObject({
      resync: false,
      entries: [{ seq: 153, event: { type: "message.delta", messageId: "live", delta: "Novo conteúdo" } }],
    })
    const current = await (await fetch(`${url}/messages?all=true`, { headers })).json()
    expect(current.messages.find((message: { id: string }) => message.id === "m0").text).toBe(
      "Editado durante a atualização",
    )
    expect(current.messages.find((message: { id: string }) => message.id === "live").text).toBe("Novo conteúdo")
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries WHERE thread_id = 't3'").get()).toEqual({
      n: 153,
    })
  } finally {
    runtime?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("backfill applies replay count and age retention without dropping legacy messages", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-migration-retention-"))
  let database: Database | undefined
  try {
    legacyDatabase(root)
    database = new Database(join(root, "touri.db"))
    const timestamp = Date.now()
    const count = TRANSCRIPT_RETENTION.entriesPerThread + 25
    database.transaction(() => {
      const insert = database?.query(
        "INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at) VALUES (?, 't0','user','text','Antigo',?,?)",
      )
      for (let index = 150; index < count; index++) insert?.run(`m${index}`, timestamp + index, timestamp + index)
      database?.exec("UPDATE messages SET updated_at = 1 WHERE thread_id = 't1'")
    })()
    database.close()
    database = openDatabase({ filename: join(root, "touri.db") })
    while (historyMigrationStatus(database).running) backfillHistoryBatch(database)
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries WHERE thread_id = 't0'").get()).toEqual({
      n: TRANSCRIPT_RETENTION.entriesPerThread,
    })
    expect(database.query("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't0'").get()).toEqual({ n: count })
    expect(database.query("SELECT through_seq FROM transcript_retention WHERE thread_id = 't0'").get()).toEqual({
      through_seq: 25,
    })
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries WHERE thread_id = 't1'").get()).toEqual({
      n: 0,
    })
    expect(database.query("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't1'").get()).toEqual({ n: 150 })
  } finally {
    database?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("final retention includes live revisions created between batches and preserves their unpublished entries", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-migration-live-retention-"))
  let database: Database | undefined
  try {
    legacyDatabase(root)
    database = openDatabase({ filename: join(root, "touri.db") })
    while (historyMigrationStatus(database).done < 64)
      backfillHistoryBatch(database, 64 - historyMigrationStatus(database).done)
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries WHERE thread_id = 't0'").get()).toEqual({
      n: 64,
    })
    const liveCount = TRANSCRIPT_RETENTION.entriesPerThread
    const insert = database.query(`INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at)
      VALUES (?, 't0','user','text','Novo',?,?)`)
    database.transaction(() => {
      for (let index = 0; index < liveCount; index++) insert.run(`live${index}`, Date.now(), Date.now())
    })()
    while (historyMigrationStatus(database).running) backfillHistoryBatch(database)
    expect(database.query("SELECT COUNT(*) AS n FROM transcript_entries WHERE thread_id = 't0'").get()).toEqual({
      n: liveCount,
    })
    expect(database.query("SELECT through_seq FROM transcript_retention WHERE thread_id = 't0'").get()).toEqual({
      through_seq: 150,
    })
    expect(database.query("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 't0'").get()).toEqual({
      n: liveCount + 150,
    })
    const bus = createEventBus(database)
    expect(database.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: liveCount })
    expect(
      database
        .query("SELECT COUNT(*) AS n FROM transcript_entries WHERE json_extract(event_json, '$.legacy') = 1")
        .get(),
    ).toEqual({ n: 450 })
    bus.stop()
  } finally {
    database?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
