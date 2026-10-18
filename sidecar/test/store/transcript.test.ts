import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, Run, UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { backfillHistoryBatch, historyMigrationStatus } from "../../src/kernel/history-backfill"
import baseSql from "../../src/kernel/migrations/0001.sql" with { type: "text" }
import notificationsSql from "../../src/kernel/migrations/0002.sql" with { type: "text" }
import avatarsSql from "../../src/kernel/migrations/0003.sql" with { type: "text" }
import machinesSql from "../../src/kernel/migrations/0004.sql" with { type: "text" }
import rolesSql from "../../src/kernel/migrations/0005.sql" with { type: "text" }
import serversSql from "../../src/kernel/migrations/0006.sql" with { type: "text" }
import { compactTranscript, materializeTranscript } from "../../src/kernel/transcript-storage"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createToolResolutions } from "../../src/runtime/tool-resolutions"
import { init as initStore } from "../../src/store"
import { MAX_TRANSCRIPT_DELTA_BYTES } from "../../src/store/transcript-rejections"

const seed = (db: Database): void => {
  db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);`)
}
const newRun = (id: string, requestMessageId: string | null = null): Run => ({
  id,
  threadId: "t",
  botId: "b",
  provider: "codex",
  trigger: "user",
  requestMessageId,
  replyMessageId: null,
  externalTurnId: null,
  status: "queued",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: Date.now(),
  startedAt: null,
  finishedAt: null,
})
const fixture = async (runtimeAvailable = true) => {
  const root = mkdtempSync(join(tmpdir(), "touri-transcript-"))
  const runtime = createKernel({ appData: root })
  const db = runtime.kernel.db as Database
  await initStore(runtime.kernel)
  seed(db)
  const store = runtime.kernel.services.use("store.api")
  if (!store?.sendMessage) throw new Error("Store missing")
  const persistence = createRuntimePersistence({ database: db })
  const calls: string[] = []
  if (runtimeAvailable)
    runtime.kernel.services.provide("runtime.enqueue", ({ requestMessageId }) => {
      calls.push(requestMessageId)
      const run = newRun(`r${calls.length}`, requestMessageId)
      persistence.saveRun(run)
      return { success: true, run }
    })
  return {
    root,
    runtime,
    db,
    store,
    persistence,
    calls,
    close: () => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
const input = (nonce = "nonce-one") => ({
  threadId: "t",
  parentId: null,
  text: "Mensagem",
  attachmentIds: [],
  clientNonce: nonce,
  deadline: Date.now() + 60_000,
})

const insertReply = (f: Awaited<ReturnType<typeof fixture>>, id = "reply", parts: MessagePart[] = []): void => {
  f.store.insertMessage({
    message: {
      id,
      threadId: "t",
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
}

test("rejected appends persist safe metadata and replay once with contiguous revisions", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    const input = { threadId: "t", messageId: "reply", partIndex: 0, delta: "Texto privado da tentativa" }
    f.store.appendDelta({ ...input, generation: 2 })
    f.store.appendDelta({ ...input, expectedSeq: 1 })
    f.store.appendDelta({ ...input, delta: "🚀".repeat(MAX_TRANSCRIPT_DELTA_BYTES / 4 + 1) })
    f.store.appendDelta({ ...input, partIndex: 2 })
    const records = f.db.query("SELECT seq, record_json FROM rejections ORDER BY seq").all() as {
      seq: number
      record_json: string
    }[]
    expect(records.map((row) => JSON.parse(row.record_json).reason)).toEqual([
      "stale_generation",
      "seq_conflict",
      "oversize",
      "validation",
    ])
    expect(records.map((row) => row.seq)).toEqual([2, 3, 4, 5])
    expect(JSON.stringify(records)).not.toContain(input.delta)
    f.store.appendDelta({ ...input, generation: 1, expectedSeq: 5, delta: "Aceito" })
    expect(f.store.activePath({ threadId: "t" })[0]?.text).toBe("Aceito")
    const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
    const base = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/threads/t/transcript`
    const page = await (await fetch(`${base}?since=1&limit=2`, { headers })).json()
    expect(page).toMatchObject({
      entries: [
        { seq: 2, event: { type: "transcript.rejected" } },
        { seq: 3, event: { type: "transcript.rejected" } },
      ],
      rejections: [
        { reason: "stale_generation", expectedGeneration: 2 },
        { reason: "seq_conflict", expectedSeq: 1 },
      ],
      hasMore: true,
      lastSeq: 6,
    })
    const bus = createEventBus(f.db)
    expect(bus.replay(0).filter(({ event }) => event.type === "transcript.rejected")).toHaveLength(4)
    bus.stop()
    const restarted = openDatabase({ filename: join(f.root, "touri.db") })
    try {
      const replay = createEventBus(restarted)
      expect(replay.replay(0).filter(({ event }) => event.type === "transcript.rejected")).toHaveLength(4)
      replay.stop()
    } finally {
      restarted.close()
    }
  } finally {
    f.close()
  }
})

test("terminal, missing and invalid appends are recorded; rolled-back rejections stay invisible", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    f.store.updateMessage({ threadId: "t", messageId: "reply", patch: { status: "complete" } })
    const input = { threadId: "t", messageId: "reply", partIndex: 0, delta: "Tardio" }
    f.store.appendDelta(input)
    f.store.appendDelta({ ...input, messageId: "missing" })
    f.store.appendDelta({ ...input, partIndex: -1 })
    f.store.appendDelta({ ...input, delta: "" })
    f.store.appendDelta({ ...input, generation: Number.NaN })
    const before = f.db.query("SELECT COUNT(*) AS n FROM rejections").get()
    const events: UiEventEnvelope[] = []
    f.runtime.kernel.subscribe((event) => events.push(event))
    expect(() =>
      f.db.transaction(() => {
        f.store.appendDelta(input)
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    await Bun.sleep(0)
    expect(f.db.query("SELECT COUNT(*) AS n FROM rejections").get()).toEqual(before)
    expect(events).toEqual([])
    expect(f.store.activePath({ threadId: "t" })[0]?.text).toBe("")
    expect(
      f.db.query("SELECT json_extract(record_json, '$.reason') AS reason FROM rejections ORDER BY seq").all(),
    ).toEqual([
      { reason: "stale_generation" },
      { reason: "validation" },
      { reason: "validation" },
      { reason: "validation" },
      { reason: "validation" },
    ])
  } finally {
    f.close()
  }
})

test("a stored sequence collision rejects the append and advances from the actual replay head", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    f.db
      .query("INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at) VALUES ('t',2,1,?,?)")
      .run(JSON.stringify({ type: "transcript.resync" }), Date.now())
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Conflito" })
    f.store.flushWrites?.()
    expect(f.db.query("SELECT seq, json_extract(record_json, '$.reason') AS reason FROM rejections").get()).toEqual({
      seq: 3,
      reason: "seq_conflict",
    })
    expect(f.store.getThread({ threadId: "t" })?.updatedSeq).toBe(3)
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Retomado", expectedSeq: 3 })
    expect(f.store.activePath({ threadId: "t" })[0]?.text).toBe("Retomado")
  } finally {
    f.close()
  }
})

test("reconciliation restores completed results missing from the message and summarizes only the active branch", async () => {
  const f = await fixture()
  try {
    const request = f.store.sendMessage?.(input())
    expect(request?.status).toBe(201)
    const queued = f.persistence.getRun("r1")
    if (!queued) throw new Error("Missing queued run")
    const run = { ...queued, status: "interrupted" as const, replyMessageId: "reply" }
    f.persistence.saveRun(run)
    const tools = createToolResolutions(f.runtime.kernel)
    const pending: MessagePart = {
      type: "tool_call",
      callId: "pending",
      tool: "read",
      summary: "",
      inputJson: "{}",
      outputJson: null,
      ok: null,
    }
    const persisted = tools.record(run, { ...pending, callId: "done", outputJson: "Resultado preservado", ok: true })
    tools.record(run, {
      type: "file_change",
      callId: "failed-change",
      paths: ["arquivo.txt"],
      diff: null,
      resolution: "failed",
    })
    const reply = f.store.insertMessage({
      message: {
        id: "reply",
        threadId: "t",
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: run.id,
        text: "",
        parts: [pending],
        sender: null,
        source: "local",
      },
    })
    expect(reply.success).toBe(true)
    tools.reconcile(f.store, "t")
    const parts = f.store.activePath({ threadId: "t" }).at(-1)?.parts
    expect(parts).toMatchObject([
      { callId: "pending", resolution: "interrupted_by_restart" },
      {
        callId: "done",
        resolution: "completed_unobserved",
        outputJson: persisted.type === "tool_call" ? persisted.outputJson : null,
        ok: true,
      },
      { callId: "failed-change", resolution: "completed_unobserved", completedOutcome: "failed" },
    ])
    const summary = tools.summary(f.store, "t")
    expect(summary).toContain("interrupted_by_restart")
    expect(summary).toContain("completed_unobserved")
    expect(summary).toContain("Resultado preservado")
    expect(summary).toContain("podem existir efeitos parciais")
    const seq = f.store.getThread({ threadId: "t" })?.updatedSeq
    tools.reconcile(f.store, "t")
    expect(f.store.getThread({ threadId: "t" })?.updatedSeq).toBe(seq)
    insertReply(f, "another-branch")
    expect(tools.summary(f.store, "t")).toBeNull()
  } finally {
    f.close()
  }
})

test("500 streaming deltas write small replay entries and growth stays linear in both journals and WAL", async () => {
  const measure = async (chunks: number) => {
    const f = await fixture()
    try {
      insertReply(f)
      f.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0")
      const delta = "Olá 🚀 ".repeat(3)
      for (let index = 0; index < chunks; index++)
        f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta })
      f.store.flushWrites?.()
      const walBytes = statSync(`${f.runtime.kernel.paths.db}-wal`).size
      const entries = f.db.query("SELECT event_json FROM transcript_entries ORDER BY seq").all() as {
        event_json: string
      }[]
      const events = f.db.query("SELECT event_json FROM ui_event_log ORDER BY seq").all() as { event_json: string }[]
      const deltas = entries.map((row) => JSON.parse(row.event_json)).filter((event) => event.type === "message.delta")
      expect(deltas.length).toBeLessThan(chunks / 10)
      expect(deltas.map((event) => event.delta).join("")).toBe(delta.repeat(chunks))
      let offset = 0
      for (const event of deltas) {
        expect(event.offset).toBe(offset)
        expect(Buffer.byteLength(event.delta)).toBeLessThanOrEqual(8192)
        offset += event.delta.length
      }
      expect(entries).toHaveLength(deltas.length + 1)
      const pointers = events.filter((row) => JSON.parse(row.event_json).type === "message.delta")
      expect(pointers).toHaveLength(deltas.length)
      expect(pointers.every((row) => JSON.parse(row.event_json).ref === true)).toBe(true)
      f.store.updateMessage({ threadId: "t", messageId: "reply", patch: { status: "complete" } })
      expect(f.store.activePath({ threadId: "t" })[0]?.text).toBe(delta.repeat(chunks))
      const bytes = [...entries, ...events].reduce((sum, row) => sum + Buffer.byteLength(row.event_json), 0)
      expect(bytes).toBeLessThan(Buffer.byteLength(delta.repeat(chunks)) * 40)
      return { bytes, walBytes }
    } finally {
      f.close()
    }
  }
  const small = await measure(500)
  const large = await measure(1000)
  expect(large.bytes).toBeLessThan(small.bytes * 2.2)
  expect(large.walBytes).toBeLessThan(small.walBytes * 2.4)
})

test("a crash before a projection checkpoint recovers text and reasoning without duplicating replay", async () => {
  const f = await fixture()
  try {
    insertReply(f, "reply", [
      { type: "reasoning", text: "" },
      { type: "text", text: "" },
    ])
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Pensando 🚀" })
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 1, delta: "Resposta" })
    f.store.flushWrites?.()
    expect(f.db.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "" })
    expect(f.db.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([
      { thread_id: "t", message_id: "reply" },
    ])
    const db = openDatabase({ filename: f.runtime.kernel.paths.db })
    try {
      const bus = createEventBus(db)
      expect(db.query("SELECT text, updated_seq FROM messages WHERE id = 'reply'").get()).toEqual({
        text: "Resposta",
        updated_seq: 3,
      })
      const parts = (db.query("SELECT parts_json FROM messages WHERE id = 'reply'").get() as { parts_json: string })
        .parts_json
      expect(JSON.parse(parts)).toEqual([
        { type: "reasoning", text: "Pensando 🚀" },
        { type: "text", text: "Resposta" },
      ])
      materializeTranscript(db)
      expect(bus.replay(0).filter((row) => row.event.type === "message.delta")).toHaveLength(2)
      expect(db.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 3 })
      expect(db.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([])
      bus.stop()
    } finally {
      db.close()
    }
  } finally {
    f.close()
  }
})

test("checkpointed transcript reads never revisit historical delta bodies", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    for (let index = 0; index < 1000; index++)
      f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Texto 🚀 " })
    // The materializer consumes the durable journal, after the stream buffer is drained.
    f.store.flushWrites?.()
    materializeTranscript(f.db)
    const reads: string[] = []
    const query = f.db.query.bind(f.db)
    f.db.query = ((sql: string) => {
      reads.push(sql)
      return query(sql)
    }) as typeof f.db.query
    try {
      for (let index = 0; index < 100; index++) materializeTranscript(f.db)
    } finally {
      f.db.query = query
    }
    expect(reads).toHaveLength(100)
    expect(reads.every((sql) => sql === "SELECT 1 FROM transcript_pending_deltas LIMIT 1")).toBe(true)
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Fim" })
    f.store.flushWrites?.()
    materializeTranscript(f.db)
    expect(f.db.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({
      text: `${"Texto 🚀 ".repeat(1000)}Fim`,
    })
    expect(f.db.query("SELECT * FROM transcript_pending_deltas").all()).toEqual([])
  } finally {
    f.close()
  }
})

test("a rolled-back delta cannot poison the next stream even if another write reuses its revision", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    expect(() =>
      f.db.transaction(() => {
        f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Descartar" })
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    insertReply(f, "other")
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: "Preservar" })
    f.store.flushWrites?.()
    materializeTranscript(f.db)
    expect(f.db.query("SELECT text FROM messages WHERE id = 'reply'").get()).toEqual({ text: "Preservar" })
    expect(f.db.query("SELECT seq FROM transcript_entries ORDER BY seq").all()).toEqual([
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
    ])
  } finally {
    f.close()
  }
})

test("retention preserves snapshots, rejects expired cursors, and only compaction may delete immutable entries", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    for (let index = 0; index < 12; index++) {
      f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: `${index}|` })
      f.store.flushWrites?.()
    }
    compactTranscript({ database: f.db, entriesPerThread: 3, events: 4, maxAgeMs: Number.MAX_SAFE_INTEGER })
    const bus = createEventBus(f.db)
    expect(f.db.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 3 })
    expect(f.db.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: 4 })
    expect(f.store.activePath({ threadId: "t" })[0]?.text).toBe(Array.from({ length: 12 }, (_, i) => `${i}|`).join(""))
    expect(bus.replay(0)).toMatchObject([{ event: { type: "transcript.resync" } }])
    const floor = Number(
      (f.db.query("SELECT value FROM schema_meta WHERE key = 'ui_event_floor_seq'").get() as { value: string }).value,
    )
    expect(bus.replay(floor).map((row) => row.seq)).toEqual([floor + 1, floor + 2, floor + 3, floor + 4])
    expect(() => f.db.exec("DELETE FROM transcript_entries")).toThrow("immutable")
    expect(() => f.db.exec("DELETE FROM ui_event_log")).toThrow("immutable")
    expect(() => f.db.exec("UPDATE ui_event_log SET at = 0")).toThrow("immutable")
    const base = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/threads/t/transcript`
    const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
    expect(await (await fetch(`${base}?since=0`, { headers })).json()).toMatchObject({
      entries: [],
      resync: true,
      lastSeq: 13,
    })
    expect(await (await fetch(`${base}?since=10`, { headers })).json()).toMatchObject({
      entries: [{ seq: 11 }, { seq: 12 }, { seq: 13 }],
      resync: false,
    })
    compactTranscript({ database: f.db, maxAgeMs: 0, now: Date.now() + 1 })
    expect(f.db.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 0 })
    expect(f.db.query("SELECT COUNT(*) AS n FROM ui_event_log").get()).toEqual({ n: 0 })
    expect(bus.replay(0)).toMatchObject([{ seq: floor + 4, event: { type: "transcript.resync" } }])
    f.runtime.kernel.publish({ type: "import.progress", importId: "new", phase: "done", done: 1, total: 1 })
    expect(bus.replay(floor + 4)).toMatchObject([{ seq: floor + 5 }])
    expect(f.db.query("SELECT * FROM transcript_maintenance").get()).toEqual({
      id: 1,
      delete_before_id: 0,
      ui_delete_before_seq: 0,
      projection_write: 0,
    })
    bus.stop()
  } finally {
    f.close()
  }
})

test("v6 migration preserves a 2.5 MB history, branches, FTS and is repeatable", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-migrate-transcript-"))
  const filename = join(root, "db.sqlite")
  try {
    const legacy = new Database(filename)
    for (const sql of [baseSql, notificationsSql, avatarsSql, machinesSql, rolesSql, serversSql]) legacy.exec(sql)
    seed(legacy)
    const text = "Conteúdo preservado ".repeat(125_000)
    legacy
      .query(
        "INSERT INTO messages(id,thread_id,parent_id,role,kind,text,created_at,updated_at) VALUES ('m','t',NULL,'user','text',?,1,1)",
      )
      .run(text)
    legacy.exec(
      "INSERT INTO messages(id,thread_id,parent_id,role,kind,text,created_at,updated_at) VALUES ('a','t','m','assistant','text','A',2,2), ('c','t','m','assistant','text','C',2,2); UPDATE threads SET active_leaf_id='c'; INSERT INTO messages_fts(text,thread_id,message_id) VALUES ('preservado','t','m');",
    )
    const before = legacy.query("SELECT * FROM messages ORDER BY rowid").all()
    legacy.close()
    for (let attempt = 0; attempt < 2; attempt++) {
      const migrated = openDatabase({ filename })
      while (historyMigrationStatus(migrated).running) backfillHistoryBatch(migrated)
      const rows = migrated.query("SELECT * FROM messages ORDER BY rowid").all() as Record<string, unknown>[]
      for (let index = 0; index < rows.length; index++)
        expect(rows[index]).toMatchObject(before[index] as Record<string, unknown>)
      expect(migrated.query("SELECT active_leaf_id FROM threads").get()).toEqual({ active_leaf_id: "c" })
      expect(migrated.query("SELECT COUNT(*) AS n FROM messages_fts").get()).toEqual({ n: 1 })
      expect(migrated.query("SELECT seq FROM messages ORDER BY seq").all()).toEqual([
        { seq: 1 },
        { seq: 2 },
        { seq: 3 },
      ])
      // This fixture's history is older than the replay retention window.
      expect(migrated.query("SELECT seq FROM transcript_entries").all()).toEqual([])
      expect(migrated.query("SELECT through_seq FROM transcript_retention").get()).toEqual({ through_seq: 3 })
      expect(migrated.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([])
      migrated.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("send journal is durable and one nonce produces exactly one message and run", async () => {
  const f = await fixture()
  try {
    const request = input()
    const first = f.store.sendMessage?.(request)
    expect(first?.status).toBe(201)
    const second = f.store.sendMessage?.(request)
    expect(second?.status).toBe(200)
    expect(f.calls).toHaveLength(1)
    expect(f.db.query("SELECT status FROM send_journal").get()).toEqual({ status: "acked" })
    expect(f.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 })
    expect(f.store.sendMessage?.({ ...request, text: "Diferente" }).status).toBe(409)
    const reopened = openDatabase({ filename: f.runtime.kernel.paths.db })
    expect(reopened.query("SELECT status, client_nonce FROM send_journal").get()).toEqual({
      status: "acked",
      client_nonce: request.clientNonce,
    })
    reopened.close()
    // Expiration cannot undo an acknowledged nonce.
    f.db.query("UPDATE send_journal SET deadline = 1").run()
    expect(f.store.sendMessage?.({ ...request, deadline: 1 }).status).toBe(200)
    expect(f.calls).toHaveLength(1)
  } finally {
    f.close()
  }
})

test("send journal preserves FIFO messages while the runtime drains", async () => {
  const f = await fixture()
  let draining = true
  f.runtime.kernel.services.provide("runtime.isDraining", () => draining)
  try {
    const first = f.store.sendMessage?.(input("first"))
    const second = f.store.sendMessage?.({ ...input("second"), text: "Segunda mensagem" })

    expect(first?.status).toBe(503)
    expect(second?.status).toBe(503)
    expect(f.calls).toEqual([])
    expect(f.db.query("SELECT status FROM send_journal ORDER BY rowid").all()).toEqual([
      { status: "queued" },
      { status: "queued" },
    ])
    const reopened = openDatabase({ filename: f.runtime.kernel.paths.db })
    expect(reopened.query("SELECT status, client_nonce FROM send_journal ORDER BY rowid").all()).toEqual([
      { status: "queued", client_nonce: "first" },
      { status: "queued", client_nonce: "second" },
    ])
    reopened.close()

    draining = false
    f.store.drainSendQueue?.()

    expect(f.calls).toEqual(["send:first", "send:second"])
    expect(f.db.query("SELECT status FROM send_journal ORDER BY rowid").all()).toEqual([
      { status: "acked" },
      { status: "acked" },
    ])
  } finally {
    f.close()
  }
})

test("expired and paused sends keep a failed delivery and create no run", async () => {
  const f = await fixture()
  try {
    expect(f.store.sendMessage?.({ ...input(), deadline: 1 }).status).toBe(409)
    expect(f.calls).toHaveLength(0)
    f.runtime.kernel.services.provide("runtime.enqueue", () => ({
      success: false,
      errorCode: "BOT_PAUSED",
      error: "Pausado",
    }))
    expect(f.store.sendMessage?.(input("paused")).status).toBe(409)
    expect(f.db.query("SELECT status FROM send_journal ORDER BY created_at").all()).toEqual([
      { status: "failed" },
      { status: "failed" },
    ])
  } finally {
    f.close()
  }
})

test("an enqueue exception rolls back its partial run and persists a terminal failure for the nonce", async () => {
  const f = await fixture(false)
  try {
    let attempts = 0
    f.runtime.kernel.services.provide("runtime.enqueue", ({ requestMessageId }) => {
      attempts += 1
      f.persistence.saveRun(newRun("partial-run", requestMessageId))
      throw new Error("private enqueue failure")
    })
    const request = input()
    for (let retry = 0; retry < 2; retry++) {
      const response = f.store.sendMessage?.(request)
      expect(response?.status).toBe(409)
      expect(response && "json" in response ? response.json : null).toMatchObject({ errorCode: "TOURI-E1010" })
    }
    f.store.drainSendQueue?.()
    expect(attempts).toBe(1)
    expect(f.persistence.getRun("partial-run")).toBeNull()
    expect(f.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 })
    expect(f.db.query("SELECT status, run_id, error_code FROM send_journal").get()).toEqual({
      status: "failed",
      run_id: null,
      error_code: "TOURI-E1010",
    })
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    f.close()
  }
})

test("a send journal write failure returns a coded error and rolls back the message before a nonce retry", async () => {
  const f = await fixture()
  try {
    f.db.exec(`CREATE TRIGGER reject_send BEFORE INSERT ON send_journal BEGIN
      SELECT RAISE(ABORT, 'private journal failure'); END`)
    const request = input()
    const response = f.store.sendMessage?.(request)
    expect(response?.status).toBe(500)
    expect(response && "json" in response ? response.json : null).toMatchObject({
      errorCode: "TOURI-E2001",
      code: "TOURI-E2001",
    })
    expect(JSON.stringify(response)).not.toContain("private journal failure")
    expect(f.calls).toHaveLength(0)
    expect(f.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 })
    expect(f.db.query("SELECT COUNT(*) AS n FROM send_journal").get()).toEqual({ n: 0 })
    f.db.exec("DROP TRIGGER reject_send")
    expect(f.store.sendMessage?.(request).status).toBe(201)
    expect(f.store.sendMessage?.(request).status).toBe(200)
    expect(f.calls).toHaveLength(1)
  } finally {
    f.close()
  }
})

test("transcript has contiguous per-thread revisions; restart replays an unpublished write", async () => {
  const f = await fixture()
  try {
    f.store.sendMessage?.(input())
    const run = f.persistence.getRun("r1")
    if (!run) throw new Error("Run missing")
    f.persistence.saveRun({ ...run, status: "starting" })
    const messageId = "send:nonce-one"
    f.store.updateMessage({ threadId: "t", messageId, patch: { text: "Nova versão" } })
    const rows = f.db
      .query("SELECT seq, generation FROM transcript_entries WHERE thread_id = 't' ORDER BY seq")
      .all() as { seq: number; generation: number }[]
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => index + 1))
    expect(rows.at(-1)?.generation).toBe(2)
    expect(() => f.db.exec("DELETE FROM transcript_entries")).toThrow("immutable")
    expect(() => f.db.exec("UPDATE transcript_entries SET at = 0")).toThrow("immutable")
    const cursor = (f.db.query("SELECT MAX(seq) AS seq FROM ui_event_log").get() as { seq: number }).seq
    f.db.exec("UPDATE messages SET text = 'Depois da queda' WHERE thread_id = 't'")
    const bus = createEventBus(f.db)
    const replayed = bus.replay(cursor)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.seq).toBe(cursor + 1)
    expect(replayed[0]?.event).toMatchObject({ type: "message.updated", message: { text: "Depois da queda" } })
    const response = await fetch(
      `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/threads/t/transcript?since=2&limit=2`,
      { headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" } },
    )
    expect(await response.json()).toMatchObject({ entries: [], hasMore: false, resync: true })
  } finally {
    f.close()
  }
})

test("transaction rollback broadcasts nothing and leaves no transcript or sequence gaps", async () => {
  const f = await fixture()
  try {
    const events: UiEventEnvelope[] = []
    f.runtime.kernel.subscribe((event) => events.push(event))
    expect(() =>
      f.db.transaction(() => {
        f.store.sendMessage?.(input())
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    await Bun.sleep(0)
    expect(events).toEqual([])
    expect(f.db.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 0 })
    f.runtime.kernel.publish({ type: "import.progress", importId: "test", phase: "done", done: 1, total: 1 })
    expect(events.map((event) => event.seq)).toEqual([1])
  } finally {
    f.close()
  }
})

test("reentrant and failing subscribers preserve ordered delivery for other clients", async () => {
  const f = await fixture()
  try {
    const sequences: number[] = []
    f.runtime.kernel.subscribe((envelope) => {
      if (envelope.seq === 1)
        f.runtime.kernel.publish({ type: "import.progress", importId: "nested", phase: "done", done: 1, total: 1 })
      throw new Error("Subscriber closed")
    })
    f.runtime.kernel.subscribe((envelope) => sequences.push(envelope.seq))
    f.db.transaction(() => {
      f.runtime.kernel.publish({ type: "import.progress", importId: "first", phase: "done", done: 1, total: 1 })
      f.runtime.kernel.publish({ type: "import.progress", importId: "second", phase: "done", done: 1, total: 1 })
    })()
    await Bun.sleep(0)
    expect(sequences).toEqual([1, 2, 3])
  } finally {
    f.close()
  }
})

test("terminal messages reject late snapshots and deltas from a second writer", async () => {
  const f = await fixture()
  try {
    const run = { ...newRun("terminal"), status: "running" as const, replyMessageId: "reply" }
    f.persistence.saveRun(run)
    f.store.insertMessage({
      message: {
        id: "reply",
        threadId: "t",
        parentId: null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: run.id,
        text: "INÍCIO",
        parts: [{ type: "text", text: "INÍCIO" }],
        sender: null,
        source: "local",
      },
    })
    f.store.updateMessage({ threadId: "t", messageId: "reply", patch: { status: "canceled" } })
    const terminal = f.store.activePath({ threadId: "t" })[0]
    f.store.updateMessage({
      threadId: "t",
      messageId: "reply",
      patch: {
        status: "streaming",
        text: "INÍCIO FIM",
        parts: [{ type: "text", text: "INÍCIO FIM" }],
      },
    })
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta: " FIM" })
    f.store.updateMessage({
      threadId: "t",
      messageId: "reply",
      patch: {
        status: "complete",
        text: "INÍCIO FIM",
        parts: [{ type: "text", text: "INÍCIO FIM" }],
      },
    })
    expect(f.store.activePath({ threadId: "t" })[0]).toEqual(terminal)
  } finally {
    f.close()
  }
})

test("restart resolves open tools and commands without changing already completed results", async () => {
  const f = await fixture()
  let engine: ReturnType<typeof createRuntimeEngine> | null = null
  try {
    const run = { ...newRun("old"), status: "running" as const, replyMessageId: "reply" }
    f.persistence.saveRun(run)
    const parts: MessagePart[] = [
      {
        type: "tool_call",
        callId: "pending",
        tool: "inspect",
        summary: "",
        inputJson: "{}",
        outputJson: null,
        ok: null,
      },
      { type: "command", callId: "cmd", command: "ls", cwd: "/tmp", exitCode: null, outputTail: "partial" },
      { type: "tool_call", callId: "done", tool: "read", summary: "", inputJson: "{}", outputJson: "result", ok: true },
    ]
    f.store.insertMessage({
      message: {
        id: "reply",
        threadId: "t",
        parentId: null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: run.id,
        text: "Parcial",
        parts,
        sender: null,
        source: "local",
      },
    })
    engine = createRuntimeEngine({ kernel: f.runtime.kernel })
    const reply = f.store.activePath({ threadId: "t" })[0]
    expect(reply?.status).toBe("failed")
    expect(reply?.text).toBe("Parcial")
    expect(reply?.parts.slice(0, 3)).toMatchObject([
      { resolution: "interrupted_by_restart" },
      { resolution: "interrupted_by_restart", outputTail: "partial" },
      { resolution: "succeeded", outputJson: "result" },
    ])
    expect(f.db.query("SELECT call_id, resolution FROM tool_resolutions ORDER BY call_id").all()).toEqual([
      { call_id: "cmd", resolution: "interrupted_by_restart" },
      { call_id: "done", resolution: "succeeded" },
      { call_id: "pending", resolution: "interrupted_by_restart" },
    ])
    const tools = createToolResolutions(f.runtime.kernel)
    const versions = (f.db.query("SELECT MAX(seq) AS seq FROM transcript_entries").get() as { seq: number }).seq
    tools.reconcile(f.store, "t")
    expect(f.db.query("SELECT MAX(seq) AS seq FROM transcript_entries").get()).toEqual({ seq: versions })
    const completed = tools.record(run, {
      ...parts[0],
      type: "tool_call",
      callId: "pending",
      tool: "inspect",
      summary: "",
      inputJson: "{}",
      outputJson: "late result",
      ok: true,
    })
    expect(completed.resolution).toBe("completed_unobserved")
  } finally {
    await engine?.shutdown()
    f.close()
  }
})

test("cancel records every open call immediately", async () => {
  const f = await fixture()
  try {
    const run = newRun("cancel")
    f.persistence.saveRun(run)
    const tools = createToolResolutions(f.runtime.kernel)
    const part = tools.record(run, {
      type: "tool_call",
      callId: "call",
      tool: "read",
      summary: "",
      inputJson: "{}",
      outputJson: null,
      ok: null,
    })
    expect(part.resolution).toBe("running")
    expect(tools.finish(run, [part], "cancelled_by_user")[0]).toMatchObject({
      resolution: "cancelled_by_user",
      ok: null,
    })
    expect(f.db.query("SELECT resolution, resolved_at FROM tool_resolutions").get()).toMatchObject({
      resolution: "cancelled_by_user",
      resolved_at: expect.any(Number),
    })
    expect(tools.record(run, part)).toMatchObject({ resolution: "cancelled_by_user" })
    expect(tools.finish(run, [part], "interrupted")[0]).toMatchObject({ resolution: "cancelled_by_user" })
  } finally {
    f.close()
  }
})

test("reconciliation closes calls persisted before an assistant message", async () => {
  const f = await fixture()
  try {
    const run = newRun("orphan")
    f.persistence.saveRun(run)
    const tools = createToolResolutions(f.runtime.kernel)
    tools.record(run, { type: "command", callId: "cmd", command: "ls", cwd: "/tmp", exitCode: null, outputTail: "" })
    f.db
      .query(
        "INSERT INTO tool_calls(id,run_id,thread_id,tool,args_json,created_at) VALUES ('audit',?,'t','read','{}',1)",
      )
      .run(run.id)
    f.persistence.saveRun({ ...run, status: "interrupted" })
    tools.reconcile(f.store)
    expect(f.db.query("SELECT resolution FROM tool_resolutions").get()).toEqual({
      resolution: "interrupted_by_restart",
    })
    expect(f.db.query("SELECT ok, error_code FROM tool_calls").get()).toEqual({
      ok: 0,
      error_code: "INTERRUPTED_BY_RESTART",
    })
  } finally {
    f.close()
  }
})

test("runtime reads committed runs after a journal transaction rolls back", async () => {
  const f = await fixture()
  try {
    expect(() =>
      f.db.transaction(() => {
        f.persistence.saveRun({ ...newRun("rolled-back"), status: "running" })
        throw new Error("rollback")
      })(),
    ).toThrow("rollback")
    expect(f.persistence.getRun("rolled-back")).toBeNull()
    expect(f.persistence.listActiveRuns()).toEqual([])
    expect(f.persistence.listQueuedRuns()).toEqual([])
  } finally {
    f.close()
  }
})

test("durable sends wait for the runtime and then drain once in FIFO order", async () => {
  const f = await fixture(false)
  try {
    const first = input("first")
    const second = { ...input("second"), parentId: "send:first" }
    expect(f.store.sendMessage?.(first).status).toBe(503)
    expect(f.store.sendMessage?.(second).status).toBe(503)
    f.runtime.kernel.services.provide("runtime.enqueue", ({ requestMessageId }) => {
      f.calls.push(requestMessageId)
      const run = newRun(`drained-${f.calls.length}`, requestMessageId)
      f.persistence.saveRun(run)
      return { success: true, run }
    })
    f.store.drainSendQueue?.()
    f.store.drainSendQueue?.()
    expect(f.calls).toEqual(["send:first", "send:second"])
    expect(f.db.query("SELECT status FROM send_journal ORDER BY rowid").all()).toEqual([
      { status: "acked" },
      { status: "acked" },
    ])
  } finally {
    f.close()
  }
})

test("an acknowledged queued run is recovered after restart without creating a second run", async () => {
  const f = await fixture()
  let engine: ReturnType<typeof createRuntimeEngine> | null = null
  try {
    f.store.sendMessage?.(input())
    engine = createRuntimeEngine({
      kernel: f.runtime.kernel,
      codexCommand: "/definitely/missing/touri-test-cli",
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && engine.listRuns("t")[0]?.finishedAt === null) await Bun.sleep(10)
    expect(engine.listRuns("t")[0]).toMatchObject({ id: "r1", status: "failed", errorClass: "cli_missing" })
    expect(f.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 })
    expect(f.db.query("SELECT status FROM send_journal").get()).toEqual({ status: "acked" })
  } finally {
    await engine?.shutdown()
    f.close()
  }
})
