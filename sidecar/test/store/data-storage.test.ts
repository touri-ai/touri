import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, Run, StorageMaintenanceStatus, ToolCallPart } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import {
  collectUnusedOutputBlobs,
  compactMessageBatch,
  createStorageMaintenance,
  dataRetentionDays,
  storageStats,
} from "../../src/kernel/data-maintenance"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import transcriptSql from "../../src/kernel/migrations/0007.sql" with { type: "text" }
import {
  boundedProcessLog,
  externalizeMessageParts,
  OUTPUT_BLOB_PREVIEW_BYTES,
  OUTPUT_BLOB_READ_BYTES,
  OUTPUT_BLOB_THRESHOLD,
  OUTPUT_INLINE_BUDGET_BYTES,
} from "../../src/kernel/output-blobs"
import { createPerformanceStageTracker, type PerformanceStageRunner } from "../../src/kernel/performance"
import { compactTranscript } from "../../src/kernel/transcript-storage"
import { createToolResolutions } from "../../src/runtime/tool-resolutions"
import { init as initStore } from "../../src/store"

const headers = {
  Authorization: "Bearer dev-ui-token",
  Origin: "tauri://localhost",
  "Content-Type": "application/json",
}
const seed = (database: Database) =>
  database.exec(`
  INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
  INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Histórico',1,1);`)
const fixture = async (automatic = false) => {
  const root = mkdtempSync(join(tmpdir(), "touri-storage-"))
  const runtime = createKernel({ appData: root })
  const stages = createPerformanceStageTracker(() => 0)
  await initStore(runtime.kernel, stages.run)
  if (!automatic) runtime.kernel.services.use("storage.maintenance")?.dispose()
  const database = runtime.kernel.db as Database
  seed(database)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  return {
    root,
    runtime,
    database,
    stages,
    store,
    close: () => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
const tool = (outputJson: string): ToolCallPart => ({
  type: "tool_call",
  callId: "call",
  tool: "test",
  summary: "Resultado da ferramenta",
  inputJson: '{"query":"teste"}',
  outputJson,
  ok: true,
  resolution: "succeeded",
})
const insert = (
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  parts: MessagePart[],
  role: "user" | "assistant" = "assistant",
) =>
  f.store.insertMessage({
    message: {
      id,
      threadId: "t",
      parentId: null,
      role,
      kind: "text",
      status: "complete",
      runId: null,
      text: "Texto preservado",
      parts,
      sender: null,
      source: "local",
    },
  })

test("startup transcript recovery is included in performance diagnostics", async () => {
  const f = await fixture()
  try {
    expect(f.stages.snapshot().map((timing) => timing.stage)).toContain("store_transcript_startup_recovery")
  } finally {
    f.close()
  }
})

for (const kind of ["text", "tool", "screenshot"] as const) {
  test(`bytes per turn: ${kind} attributes snapshot/event/blob growth and bounds DB duplication`, async () => {
    const f = await fixture()
    const legacy = openDatabase({ filename: join(f.root, "legacy.db") })
    // Reproduce the shipped full-snapshot writer. Opening a second current DB
    // would compare against the new locator format and hide the saved copies.
    legacy.exec("DROP TRIGGER messages_transcript_insert; DROP TRIGGER messages_transcript_update;")
    legacy.exec(
      transcriptSql.slice(
        transcriptSql.indexOf("CREATE TRIGGER messages_transcript_insert"),
        transcriptSql.indexOf("CREATE TRIGGER run_transcript_generation"),
      ),
    )
    seed(legacy)
    const bus = createEventBus(legacy)
    try {
      f.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      const initial = statSync(join(f.root, "touri.db")).size
      const legacyInitial = statSync(join(f.root, "legacy.db")).size
      const rawInsert = legacy.query(
        "INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at) VALUES (?,'t',?,'text','Texto preservado',?,?,?)",
      )
      for (let turn = 0; turn < 10; turn++) {
        const output =
          kind === "tool"
            ? `${turn}: ${"resultado ".repeat(15_000)}`
            : JSON.stringify([
                { type: "image", mimeType: "image/png", data: Buffer.alloc(100_000, turn).toString("base64") },
              ])
        const parts: MessagePart[] =
          kind === "text" ? [{ type: "text", text: `${turn}: ${"Resposta. ".repeat(200)}` }] : [tool(output)]
        insert(f, `user${turn}`, [{ type: "text", text: "Pergunta" }], "user")
        insert(f, `reply${turn}`, parts)
        rawInsert.run(
          `user${turn}`,
          "user",
          JSON.stringify([{ type: "text", text: "Pergunta" }]),
          Date.now(),
          Date.now(),
        )
        rawInsert.run(`reply${turn}`, "assistant", JSON.stringify(parts), Date.now(), Date.now())
        bus.publish({ type: "transcript.resync" })
      }
      f.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      const stats = storageStats(f.database, join(f.root, "touri.db"))
      const old = storageStats(legacy, join(f.root, "legacy.db"))
      expect(stats.turns).toBe(10)
      const logical = stats.messageTextBytes + stats.messagePartsBytes + stats.transcriptBytes + stats.eventBytes
      const oldLogical = old.messageTextBytes + old.messagePartsBytes + old.transcriptBytes + old.eventBytes
      if (kind === "text") {
        expect(stats.attachmentBytes).toBe(0)
        expect(logical / oldLogical).toBeLessThan(1.2)
      } else {
        expect(logical / oldLogical).toBeLessThan(0.03)
        expect(stats.attachmentBytes).toBeGreaterThan(1_000_000)
        expect((stats.databaseBytes - initial) / (old.databaseBytes - legacyInitial)).toBeLessThan(0.2)
      }
      console.info(
        `Bytes/turn (${kind}): DB ${(stats.databaseBytes - initial) / 10}; text ${stats.messageTextBytes / 10}; parts ${stats.messagePartsBytes / 10}; transcript ${stats.transcriptBytes / 10}; UI events ${stats.eventBytes / 10}; blobs ${stats.attachmentBytes / 10}; legacy payload ${oldLogical / 10}`,
      )
    } finally {
      bus.stop()
      legacy.close()
      f.close()
    }
  })
}

test("blob cutoff measures UTF-8 bytes; screenshots below cutoff are offloaded; files survive reopening and deduplicate", async () => {
  const f = await fixture()
  let reopened: Database | undefined
  try {
    expect(OUTPUT_BLOB_THRESHOLD).toBe(8 * 1024)
    insert(f, "boundary", [tool("x".repeat(OUTPUT_BLOB_THRESHOLD))])
    expect((f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart)?.outputAttachmentId).toBeUndefined()
    const output = "é".repeat(40_000)
    for (const id of ["one", "two"]) insert(f, id, [tool(output)])
    const part = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    expect(part.outputJson).toBeNull()
    expect(part.outputPreview).toBe("é".repeat(OUTPUT_BLOB_PREVIEW_BYTES / 2))
    expect(part.outputBytes).toBe(80_000)
    const blob = f.database.query("SELECT path FROM attachments WHERE id = ?").get(part.outputAttachmentId ?? "") as {
      path: string
    }
    expect(readFileSync(blob.path, "utf8")).toBe(output)
    expect(statSync(blob.path).mode & 0o777).toBe(0o600)
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 })
    insert(f, "screenshot", [tool(JSON.stringify({ dataBase64: "aW1hZ2U=", mime: "image/png" }))])
    expect((f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart)?.outputAttachmentId).toBeDefined()
    const response = await fetch(
      `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/attachments/${part.outputAttachmentId}`,
      { headers },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(output)
    f.runtime.stop()
    reopened = openDatabase({ filename: join(f.root, "touri.db") })
    expect(
      JSON.parse(
        (reopened.query("SELECT parts_json FROM messages WHERE id = 'one'").get() as { parts_json: string }).parts_json,
      )[0].outputAttachmentId,
    ).toBe(part.outputAttachmentId)
    expect(readFileSync(blob.path, "utf8")).toBe(output)
  } finally {
    reopened?.close()
    f.close()
  }
})

test("live output stays inline and completion writes one content-addressed body with a bounded preview", async () => {
  const f = await fixture()
  try {
    const output = `${"line\n".repeat(3000)}última linha`
    const command: MessagePart = {
      type: "command",
      callId: "cmd",
      command: "printf resultado",
      cwd: "/tmp",
      exitCode: null,
      outputTail: output,
      resolution: "running",
    }
    const live = externalizeMessageParts({ database: f.database, appData: f.root, parts: [command] })
    expect(live).toEqual([command])
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 })
    const parts = externalizeMessageParts({
      database: f.database,
      appData: f.root,
      parts: [{ ...command, exitCode: 0, resolution: "succeeded" }],
    })
    const stored = parts[0]
    if (stored?.type !== "command") throw new Error("Missing command result")
    expect(stored.outputAttachmentId).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.outputTail).toBe("")
    expect(stored.outputPreview?.endsWith("última linha")).toBe(true)
    expect(Buffer.byteLength(stored.outputPreview ?? "")).toBeLessThanOrEqual(OUTPUT_BLOB_PREVIEW_BYTES)
    expect(externalizeMessageParts({ database: f.database, appData: f.root, parts })).toEqual(parts)
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 })
    insert(f, "completed", parts)
    f.database.query("UPDATE messages SET updated_at = 1 WHERE id = 'completed'").run()
    compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100 })
    const summary = JSON.parse(
      (f.database.query("SELECT parts_json FROM messages WHERE id = 'completed'").get() as { parts_json: string })
        .parts_json,
    ) as MessagePart[]
    expect(summary[0]).not.toHaveProperty("outputPreview")
  } finally {
    f.close()
  }
})

test("saved output pages cap reads and preserve UTF-8 across continuation cursors", async () => {
  const f = await fixture()
  try {
    const output = `${"a".repeat(OUTPUT_BLOB_READ_BYTES - 1)}🦜${"é".repeat(70_000)}`
    insert(f, "paged", [tool(output)])
    const part = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    const url = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/attachments/${part.outputAttachmentId}/content`
    const first = await fetch(`${url}?limit=999999999`, { headers })
    expect(first.status).toBe(200)
    type Page = { text: string; offset: number; nextOffset: number | null; bytes: number }
    let page = (await first.json()) as Page
    expect(page.text).toBe("a".repeat(OUTPUT_BLOB_READ_BYTES - 1))
    expect(page.nextOffset).toBe(OUTPUT_BLOB_READ_BYTES - 1)
    expect(page.bytes).toBe(Buffer.byteLength(output))
    let restored = page.text
    while (page.nextOffset !== null) {
      const offset = page.nextOffset
      page = (await (await fetch(`${url}?offset=${offset}`, { headers })).json()) as Page
      expect(page.offset).toBe(offset)
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(OUTPUT_BLOB_READ_BYTES)
      expect(page.text).not.toContain("�")
      restored += page.text
    }
    expect(restored).toBe(output)
    for (const query of ["offset=-1", "offset=1.5", "offset=999999999", "limit=0", "limit=invalid"])
      expect((await fetch(`${url}?${query}`, { headers })).status).toBe(400)
    expect((await fetch(url)).status).toBe(401)
  } finally {
    f.close()
  }
})

test("output ranges remain readable when a prior user upload already owns the same content hash", async () => {
  const f = await fixture()
  try {
    const output = "Resultado compartilhado. ".repeat(1000)
    const baseUrl = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/attachments`
    const uploaded = await fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "resultado.txt", dataBase64: Buffer.from(output).toString("base64") }),
    })
    expect(uploaded.status).toBe(201)
    const { attachment } = (await uploaded.json()) as { attachment: { id: string } }
    insert(f, "shared-upload", [tool(output)])
    const part = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    expect(part.outputAttachmentId).toBe(attachment.id)
    const response = await fetch(`${baseUrl}/${attachment.id}/content`, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: output, nextOffset: null })
  } finally {
    f.close()
  }
})

test("a compact tool patch alone keeps its output body until the journal is retained out", async () => {
  const f = await fixture()
  try {
    const [part] = externalizeMessageParts({
      database: f.database,
      appData: f.root,
      parts: [tool("Resultado do diário. ".repeat(1000))],
    })
    f.database.query("INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at) VALUES ('t',1,1,?,?)").run(
      JSON.stringify({
        type: "message.parts",
        threadId: "t",
        messageId: "reply",
        updatedSeq: 1,
        generation: 1,
        parts: [{ partIndex: 0, part }],
      }),
      Date.now(),
    )
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0) // unpublished recovery tail stays protected
    f.runtime.kernel.publish({ type: "transcript.resync" })
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(1)
  } finally {
    f.close()
  }
})

test("retention releases completed recovery outputs when only snapshot locators remain", async () => {
  const f = await fixture()
  try {
    f.database.exec(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) SELECT 'r','t','b',provider,'user','succeeded',1 FROM bots WHERE id='b'",
    )
    const tools = createToolResolutions(f.runtime.kernel)
    const part = tools.record({ id: "r", threadId: "t" } as Run, tool("Resultado antigo. ".repeat(1000)))
    insert(f, "old-recovery", [part])
    f.database.query("UPDATE messages SET run_id = 'r', updated_at = 1 WHERE id = 'old-recovery'").run()
    compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100 })
    const record = f.database.query("SELECT part_json FROM tool_resolutions WHERE run_id = 'r'").get() as {
      part_json: string
    }
    expect(JSON.parse(record.part_json)).not.toHaveProperty("outputAttachmentId")
    expect(JSON.parse(record.part_json)).not.toHaveProperty("outputPreview")
    // Snapshot locators resolve to the retained summary; they do not keep the
    // removed body alive after both message and recovery retention have expired.
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(1)
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
    f.runtime.kernel.publish({ type: "transcript.resync" })
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
  } finally {
    f.close()
  }
})

test("30-day retention preserves conversation text, tool summaries, status and FTS; retries add no events or summaries", async () => {
  const f = await fixture()
  try {
    insert(f, "old", [
      tool("x".repeat(80_000)),
      { ...tool("small result"), outputTail: "Old command details" },
      { ...tool(""), inputJson: "{}", outputJson: null, outputTail: "Preview-only details" },
      { type: "reasoning", text: "Raciocínio antigo" },
    ])
    insert(f, "recent", [tool("y".repeat(80_000))])
    f.database.query("UPDATE messages SET updated_at = ? WHERE id = 'old'").run(Date.now() - 31 * 86400_000)
    const before = f.database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()
    compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100 })
    const old = JSON.parse(
      (f.database.query("SELECT parts_json FROM messages WHERE id = 'old'").get() as { parts_json: string }).parts_json,
    ) as MessagePart[]
    expect(old[0]).toMatchObject({
      type: "tool_call",
      summary: "Resultado da ferramenta",
      resolution: "succeeded",
      ok: true,
      inputJson: "{}",
      outputJson: null,
    })
    expect((old[0] as ToolCallPart).outputAttachmentId).toBeUndefined()
    expect(old.filter((part) => part.type === "tool_call").map((part) => part.outputTail)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(old.some((part) => part.type === "reasoning")).toBe(false)
    expect(old.filter((part) => part.type === "notice" && part.code === "compaction")).toHaveLength(1)
    expect(f.database.query("SELECT text,status FROM messages WHERE id = 'old'").get()).toEqual({
      text: "Texto preservado",
      status: "complete",
    })
    expect(f.store.search({ q: "preservado", limit: 10 })).toHaveLength(2)
    expect((f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart)?.outputAttachmentId).toBeDefined()
    compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100 })
    expect(f.database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual(before)
    expect(
      JSON.parse(
        (f.database.query("SELECT parts_json FROM messages WHERE id = 'old'").get() as { parts_json: string })
          .parts_json,
      ),
    ).toEqual(old)
    // Locators hydrate the retained projection; expired output has no stale
    // snapshot body keeping its file alive after the configured retention pass.
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(1)
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 })
  } finally {
    f.close()
  }
})

test("retention preference persists, rejects invalid values and 0 keeps old details", async () => {
  const f = await fixture()
  try {
    const url = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/settings`
    expect(dataRetentionDays(f.database)).toBe(30)
    for (const days of [-1, 1.5, 3651, "30", null]) {
      const response = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ dataRetentionDays: days }) })
      expect(response.status).toBe(400)
    }
    expect(
      (await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ dataRetentionDays: 0 }) })).status,
    ).toBe(200)
    expect(f.runtime.kernel.services.use("store.settings")?.().dataRetentionDays).toBe(0)
    insert(f, "old", [tool("Detalhes originais")])
    f.database.query("UPDATE messages SET updated_at = 1").run()
    compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100 })
    expect((f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart)?.outputJson).toBe("Detalhes originais")
    f.runtime.stop()
    const database = openDatabase({ filename: join(f.root, "touri.db") })
    try {
      expect(dataRetentionDays(database)).toBe(0)
    } finally {
      database.close()
    }
  } finally {
    f.close()
  }
})

test("maintenance skips streaming messages and threads with active runs, and offloads command/diff results", async () => {
  const f = await fixture()
  try {
    insert(f, "stream", [tool("live")])
    f.database.query("UPDATE messages SET status = 'streaming', updated_at = 1 WHERE id = 'stream'").run()
    insert(f, "command", [
      {
        type: "command",
        callId: "cmd",
        command: "echo teste",
        cwd: "/tmp",
        exitCode: 0,
        outputTail: "c".repeat(80_000),
      },
    ])
    insert(f, "diff", [{ type: "file_change", callId: "diff", paths: ["a.txt"], diff: "d".repeat(80_000) }])
    const next = compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100, limit: 2 })
    expect(next.cursor).toBe(2)
    expect(
      JSON.parse(
        (f.database.query("SELECT parts_json FROM messages WHERE id = 'stream'").get() as { parts_json: string })
          .parts_json,
      )[0].outputJson,
    ).toBe("live")
    f.database.exec(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','running',1)",
    )
    f.database.query("UPDATE messages SET updated_at = 1").run()
    const before = f.database.query("SELECT parts_json FROM messages ORDER BY rowid").all()
    compactMessageBatch({ database: f.database, appData: f.root, cursor: 0, total: 100 })
    expect(f.database.query("SELECT parts_json FROM messages ORDER BY rowid").all()).toEqual(before)
  } finally {
    f.close()
  }
})

test("Doctor starts background compaction once; only explicit VACUUM shrinks allocated pages", async () => {
  const f = await fixture(true)
  try {
    insert(f, "old", [tool("x".repeat(500_000))])
    // Represent an existing schema-7 snapshot/event payload, before offloading.
    f.database
      .query("UPDATE messages SET parts_json = ?, updated_at = 1 WHERE id = 'old'")
      .run(JSON.stringify([tool("x".repeat(500_000))]))
    f.runtime.kernel.publish({ type: "transcript.resync" })
    f.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const sizeBefore = statSync(join(f.root, "touri.db")).size
    const url = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/doctor/storage`
    const wait = async () => {
      let state: StorageMaintenanceStatus = { running: true, processed: 0, total: 0 }
      const deadline = Date.now() + 5000
      while (state.running && Date.now() < deadline) {
        await Bun.sleep(10)
        state = (await (await fetch(url, { headers })).json()).maintenance
      }
      expect(state.running).toBe(false)
      expect(state.error).toBeUndefined()
    }
    const request = () => fetch(`${url}/compact`, { method: "POST", headers, body: JSON.stringify({}) })
    const [first, second] = await Promise.all([request(), request()])
    expect([first.status, second.status].sort()).toEqual([202, 409])
    await wait()
    f.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    expect(statSync(join(f.root, "touri.db")).size).toBeGreaterThanOrEqual(sizeBefore)
    const stats = (await (await fetch(url, { headers })).json()).storage
    expect(stats.reusableBytes).toBeGreaterThan(400_000)
    expect(
      (await fetch(`${url}/compact`, { method: "POST", headers, body: JSON.stringify({ vacuum: true }) })).status,
    ).toBe(202)
    await wait()
    expect(statSync(join(f.root, "touri.db")).size).toBeLessThan(sizeBefore / 2)
    expect(f.database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(f.store.search({ q: "preservado", limit: 10 })).toHaveLength(1)
  } finally {
    f.close()
  }
})

test("background maintenance resumes a committed cursor after restart without re-writing summaries", async () => {
  const f = await fixture(true)
  let resumed: ReturnType<typeof createKernel> | undefined
  try {
    const rawInsert = f.database.query(
      "INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at) VALUES (?,'t','assistant','text','Preservado',?,1,1)",
    )
    f.database.transaction(() => {
      for (let index = 0; index < 1200; index++)
        rawInsert.run(
          `legacy${index}`,
          JSON.stringify([tool("Detalhes antigos"), { type: "reasoning", text: "Raciocínio" }]),
        )
    })()
    f.runtime.kernel.publish({ type: "transcript.resync" })
    const maintenance = f.runtime.kernel.services.use("storage.maintenance")
    const deadline = Date.now() + 5000
    while (!maintenance?.snapshot().processed && Date.now() < deadline) await Bun.sleep(10)
    const committed = maintenance?.snapshot()
    expect(committed?.running).toBe(true)
    expect(committed?.processed).toBeGreaterThan(0)
    expect(committed?.processed).toBeLessThan(1200)
    f.runtime.stop()
    resumed = createKernel({ appData: f.root })
    const next = resumed.kernel.services.use("storage.maintenance")
    expect(next?.snapshot().processed).toBe(committed?.processed)
    while (((next?.snapshot().processed ?? 0) < 1200 || next?.snapshot().running) && Date.now() < deadline)
      await Bun.sleep(10)
    expect(next?.snapshot()).toEqual({ running: false, processed: 1200, total: 1200 })
    const database = resumed.kernel.db as Database
    expect(
      database
        .query("SELECT COUNT(*) AS n FROM messages WHERE json_extract(parts_json,'$[0].outputJson') IS NULL")
        .get(),
    ).toEqual({ n: 1200 })
    expect(
      database
        .query(
          "SELECT COUNT(*) AS n FROM messages m, json_each(m.parts_json) p WHERE json_extract(p.value,'$.code') = 'compaction'",
        )
        .get(),
    ).toEqual({ n: 1200 })
    expect(database.query("SELECT MIN(updated_seq) AS first, MAX(updated_seq) AS last FROM messages").get()).toEqual({
      first: 1,
      last: 1200,
    })
    expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  } finally {
    resumed?.stop()
    f.close()
  }
})

test("rollback orphans are collected after a grace period without deleting a shared live output", async () => {
  const f = await fixture()
  try {
    expect(() =>
      f.database.transaction(() => {
        insert(f, "rollback", [tool("orphan".repeat(20_000))])
        throw new Error("Interrompido")
      })(),
    ).toThrow("Interrompido")
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
    insert(f, "live", [tool("shared".repeat(20_000))])
    expect(await collectUnusedOutputBlobs(f.database, f.root, Date.now() + 2 * 86400_000)).toBe(1)
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 })
    f.store.updateMessage({ threadId: "t", messageId: "live", patch: { parts: [tool("Novo resultado pequeno")] } })
    const part = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    expect(part.outputAttachmentId).toBeUndefined()
    expect(part.outputJson).toBe("Novo resultado pequeno")
  } finally {
    f.close()
  }
})

test("garbage collection yields and defers deletion if a live writer introduces new references", async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 100; index++) insert(f, `m${index}`, [tool(`${index}: ${"x".repeat(80_000)}`)])
    const blob = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    f.database.exec("UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1")
    f.database.query("UPDATE messages SET parts_json = '[]' WHERE id = 'm99'").run()
    f.database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1")
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    let yields = 0
    const removed = await collectUnusedOutputBlobs(f.database, f.root, Date.now(), async () => {
      yields += 1
      insert(f, "new-reference", [{ ...tool(""), outputJson: null, outputAttachmentId: blob.outputAttachmentId ?? "" }])
    })
    expect(yields).toBe(1)
    expect(removed).toBe(0)
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 100 })
  } finally {
    f.close()
  }
})

test("orphan attachment scanning yields after bounded directory batches and reports its stage", async () => {
  const f = await fixture()
  try {
    const directory = join(f.root, "attachments", "aa")
    mkdirSync(directory, { recursive: true })
    Array.from({ length: 150 }, (_, index) => index).forEach((index) => {
      const id = `aa${index.toString(16).padStart(62, "0")}`
      writeFileSync(join(directory, `${id}.tool-output.txt`), "synthetic")
    })
    let yields = 0
    const stages = createPerformanceStageTracker(() => 0)

    const removed = await collectUnusedOutputBlobs(
      f.database,
      f.root,
      Date.now(),
      async () => {
        yields += 1
      },
      new Set(),
      stages.run,
    )

    expect(removed).toBe(0)
    expect(yields).toBe(3)
    expect(stages.snapshot().map((timing) => timing.stage)).toContain("storage_attachment_orphan_scan")
    expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 })
  } finally {
    f.close()
  }
})

test("a user upload sharing a tool-output hash remains after tool retention removes all references", async () => {
  const f = await fixture()
  try {
    insert(f, "tool", [tool("Resultado compartilhado".repeat(4000))])
    const blob = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    const stored = f.database.query("SELECT path FROM attachments WHERE id = ?").get(blob.outputAttachmentId ?? "") as {
      path: string
    }
    const response = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/attachments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "upload.txt", dataBase64: readFileSync(stored.path).toString("base64") }),
    })
    expect(response.status).toBe(201)
    f.store.updateMessage({ threadId: "t", messageId: "tool", patch: { parts: [] } })
    compactTranscript({ database: f.database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: Date.now() + 1 })
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
    expect(readFileSync(stored.path, "utf8")).toContain("Resultado compartilhado")
  } finally {
    f.close()
  }
})

test("interrupted tool reconciliation preserves file-backed results even without a message reference", async () => {
  const f = await fixture()
  try {
    f.database.exec(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','interrupted',1)",
    )
    const run = { id: "r", threadId: "t" } as Run
    const tools = createToolResolutions(f.runtime.kernel)
    const output = "Resultado preservado. ".repeat(10_000)
    const recorded = tools.record(run, tool(output))
    expect(recorded.outputAttachmentId).toBeString()
    expect(recorded).toMatchObject({ outputJson: null, resolution: "succeeded" })
    const row = f.database.query("SELECT part_json FROM tool_resolutions WHERE run_id = 'r'").get() as {
      part_json: string
    }
    expect(row.part_json.length).toBeLessThan(2048)
    const recovered = tools.finish(run, [], "interrupted_by_restart")
    expect(recovered).toEqual([{ ...recorded, resolution: "completed_unobserved" }])
    expect(await collectUnusedOutputBlobs(f.database, f.root)).toBe(0)
    const blob = f.database
      .query("SELECT path FROM attachments WHERE id = ?")
      .get(recorded.outputAttachmentId ?? "") as { path: string }
    expect(readFileSync(blob.path, "utf8")).toBe(output)
  } finally {
    f.close()
  }
})

test("many small command and tool outputs share a bounded inline budget without losing full results", async () => {
  const f = await fixture()
  try {
    const outputs = Array.from({ length: 50 }, (_, index) => `${index}: ${"é".repeat(2000)}`)
    const parts: MessagePart[] = outputs.map((output, index) =>
      index % 2
        ? { ...tool(output), callId: `tool-${index}` }
        : {
            type: "command",
            callId: `command-${index}`,
            command: "echo teste",
            cwd: "/tmp",
            exitCode: 0,
            outputTail: output,
          },
    )
    insert(f, "many", parts)
    const message = f.store.activePath({ threadId: "t" })[0]
    let inlineBytes = 0
    let externalized = 0
    for (const [index, part] of (message?.parts ?? []).entries()) {
      if (part.type !== "tool_call" && part.type !== "command") throw new Error("Unexpected part")
      const expectedOutput = outputs[index]
      if (expectedOutput === undefined) throw new Error("Output missing")
      const inline = part.type === "tool_call" ? part.outputJson : part.outputTail
      inlineBytes += Buffer.byteLength(inline ?? "")
      if (part.outputAttachmentId) {
        externalized++
        const blob = f.database.query("SELECT path FROM attachments WHERE id = ?").get(part.outputAttachmentId) as {
          path: string
        }
        expect(readFileSync(blob.path, "utf8")).toBe(expectedOutput)
      } else expect(inline).toBe(expectedOutput)
    }
    expect(inlineBytes).toBeLessThanOrEqual(OUTPUT_INLINE_BUDGET_BYTES)
    expect(externalized).toBeGreaterThan(0)
    const entry = f.database.query("SELECT MAX(length(event_json)) AS n FROM transcript_entries").get() as { n: number }
    expect(entry.n).toBeLessThan(256)
    expect(parts[49]).toMatchObject({ outputJson: outputs[49] })
  } finally {
    f.close()
  }
})

test("tool progress tails cannot bypass output offloading and repeated writes add no versions", async () => {
  const f = await fixture()
  try {
    const output = "Progresso completo. ".repeat(5000)
    const part = { ...tool(""), outputJson: null, outputTail: output, ok: null } as ToolCallPart
    insert(f, "progress", [part])
    const message = f.store.activePath({ threadId: "t" })[0]
    if (!message) throw new Error("Message missing")
    const stored = message.parts[0] as ToolCallPart
    expect(stored.outputAttachmentId).toBeString()
    expect(stored.outputTail).toBeUndefined()
    const blob = f.database.query("SELECT path FROM attachments WHERE id = ?").get(stored.outputAttachmentId ?? "") as {
      path: string
    }
    expect(readFileSync(blob.path, "utf8")).toBe(output)
    const before = f.database.query("SELECT total_changes() AS n").get()
    f.store.updateMessage({ threadId: "t", messageId: "progress", patch: { parts: message.parts } })
    expect(f.database.query("SELECT total_changes() AS n").get()).toEqual(before)
    expect(f.database.query("SELECT COUNT(*) AS n FROM transcript_entries").get()).toEqual({ n: 1 })

    f.database.exec(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','running',1)",
    )
    const resolutions = createToolResolutions(f.runtime.kernel)
    const run = { id: "r", threadId: "t" } as Run
    resolutions.record(run, tool("Resultado"))
    const changes = f.database.query("SELECT total_changes() AS n").get()
    resolutions.record(run, tool("Resultado"))
    expect(f.database.query("SELECT total_changes() AS n").get()).toEqual(changes)
  } finally {
    f.close()
  }
})

test("completed output cannot crowd live command progress into a new file on every frame", async () => {
  const f = await fixture()
  try {
    const parts: MessagePart[] = Array.from({ length: 20 }, (_, index) => ({
      type: "command",
      callId: `done-${index}`,
      command: "echo teste",
      cwd: "/tmp",
      exitCode: 0,
      outputTail: `${index}: ${"x".repeat(4000)}`,
    }))
    const running = {
      type: "command" as const,
      callId: "running",
      command: "echo progresso",
      cwd: "/tmp",
      exitCode: null,
      outputTail: "0".repeat(16 * 1024),
    }
    parts.push(running)
    insert(f, "progress-budget", parts)
    const files = f.database.query("SELECT COUNT(*) AS n FROM attachments").get()
    for (let frame = 1; frame <= 8; frame++) {
      const outputTail = String(frame).repeat(16 * 1024)
      parts[parts.length - 1] = { ...running, outputTail }
      f.store.updateMessage({ threadId: "t", messageId: "progress-budget", patch: { parts } })
      const saved = f.store.activePath({ threadId: "t" })[0]?.parts
      if (!saved) throw new Error("Message missing")
      const progress = saved.at(-1)
      if (progress?.type !== "command") throw new Error("Command missing")
      expect(progress.outputTail).toBe(outputTail)
      expect(progress.outputAttachmentId).toBeUndefined()
      const inlineBytes = saved.reduce(
        (total, part) => total + (part.type === "command" ? Buffer.byteLength(part.outputTail) : 0),
        0,
      )
      expect(inlineBytes).toBeLessThanOrEqual(OUTPUT_INLINE_BUDGET_BYTES)
      expect(f.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual(files)
    }
  } finally {
    f.close()
  }
})

test("final tool previews remain visible and oversized result plus preview stays fully recoverable", async () => {
  const f = await fixture()
  try {
    const outputTail = "step 1\nstep 2\n"
    insert(f, "final-preview", [{ ...tool("done"), outputTail }])
    expect(f.store.activePath({ threadId: "t" })[0]?.parts[0]).toMatchObject({ outputJson: "done", outputTail })
    const completeTail = "Saída completa. ".repeat(8000)
    insert(f, "large-preview", [{ ...tool("done"), outputTail: completeTail }])
    const part = f.store.activePath({ threadId: "t" })[0]?.parts[0] as ToolCallPart
    expect(part.outputJson).toBeNull()
    expect(part.outputTail).toBeUndefined()
    expect(part.outputAttachmentId).toBeString()
    const blob = f.database.query("SELECT path FROM attachments WHERE id = ?").get(part.outputAttachmentId ?? "") as {
      path: string
    }
    expect(JSON.parse(readFileSync(blob.path, "utf8"))).toEqual({ outputJson: "done", outputTail: completeTail })
  } finally {
    f.close()
  }
})

test("process replay keeps a bounded UTF-8 tail of the file-backed log", () => {
  const tail = "Fim 🚀"
  const event = { type: "process.log" as const, processId: "p", lines: ["é".repeat(100_000), tail] }
  const bounded = boundedProcessLog(event)
  expect(Buffer.byteLength(bounded.lines.join("\n"))).toBeLessThanOrEqual(OUTPUT_INLINE_BUDGET_BYTES)
  expect(bounded.lines.at(-1)).toBe(tail)
  expect(bounded.lines.join("\n")).not.toContain("�")
  expect(event.lines[0]?.length).toBe(100_000)
})

const scanCleanups = new Set<() => void>()
afterEach(() => {
  // Reverse only the fresh snapshot so dependent connections close first.
  Array.from(scanCleanups)
    .reverse()
    .forEach((cleanup) => {
      cleanup()
    })
  scanCleanups.clear()
})

const makeScanFixture = async () => {
  const scan = await fixture()
  scanCleanups.add(scan.close)

  return scan
}

const makeOutputCandidates = (scan: Awaited<ReturnType<typeof fixture>>, count: number) => {
  const directory = join(scan.root, "attachments", "ab")
  mkdirSync(directory, { recursive: true })

  return Array.from({ length: count }, (_, index) => {
    const id = `ab${index.toString(16).padStart(62, "0")}`
    const path = join(directory, `${id}.tool-output.txt`)
    writeFileSync(path, "synthetic output")
    scan.database
      .query(`INSERT INTO attachments(id,mime,bytes,path,origin_path,created_at)
      VALUES (?,'text/plain',16,?,'touri:tool-output',1)`)
      .run(id, path)

    return { id, path }
  })
}

test("old orphan files are removed across multiple yielded partitions while recent files remain", async () => {
  const scan = await makeScanFixture()
  const candidates = makeOutputCandidates(scan, 125)
  scan.database.exec("DELETE FROM attachments")
  const recent = candidates.at(-1)
  const old = candidates.filter((candidate) => candidate !== recent)
  old.forEach((candidate) => {
    utimesSync(candidate.path, 1, 1)
  })
  let yields = 0

  const removed = await collectUnusedOutputBlobs(scan.database, scan.root, Date.now(), async () => {
    yields += 1
  })

  expect(removed).toBe(124)
  expect(yields).toBeGreaterThanOrEqual(2)
  expect(old.every((candidate) => !existsSync(candidate.path))).toBe(true)
  expect(recent && existsSync(recent.path)).toBe(true)
})

test("attachment candidates use bounded rowid pages and never materialize an eligible-ID SQL list", async () => {
  const scan = await makeScanFixture()
  makeOutputCandidates(scan, 125)
  const queries: string[] = []
  const pageSizes: number[] = []
  // The recorder wraps only this fixture's connection, preserving native receivers.
  const database = new Proxy(scan.database, {
    get(target, key) {
      if (key !== "query") {
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return (sql: string) => {
        queries.push(sql)
        const statement = target.query(sql)
        if (!sql.includes("FROM attachments")) return statement

        return new Proxy(statement, {
          get(statement, key) {
            if (key === "all")
              return (...args: Array<string | number>) => {
                const rows = statement.all(...args)
                pageSizes.push(rows.length)

                return rows
              }
            const value = Reflect.get(statement, key, statement)
            return typeof value === "function" ? value.bind(statement) : value
          },
        })
      }
    },
  })
  let yields = 0

  const removed = await collectUnusedOutputBlobs(database, scan.root, Date.now(), async () => {
    yields += 1
  })

  expect(removed).toBe(125)
  expect(yields).toBeGreaterThanOrEqual(3)
  expect(Math.max(...pageSizes)).toBeLessThanOrEqual(50)
  expect(queries.some((query) => query.includes("json_each"))).toBe(false)
})

test("a writer invalidates collection and the next pass fully rescans earlier candidates", async () => {
  const scan = await makeScanFixture()
  const [shared, orphan] = makeOutputCandidates(scan, 2)
  if (!shared || !orphan) throw new Error("Missing synthetic candidates")
  let deferred = 0

  const first = await collectUnusedOutputBlobs(
    scan.database,
    scan.root,
    Date.now(),
    async () => {
      insert(scan, "late-reference", [{ ...tool(""), outputJson: null, outputAttachmentId: shared.id }])
    },
    new Set(),
    undefined,
    () => {
      deferred += 1
    },
  )
  const second = await collectUnusedOutputBlobs(scan.database, scan.root)

  expect(first).toBe(0)
  expect(deferred).toBe(1)
  expect(second).toBe(1)
  expect(existsSync(shared.path)).toBe(true)
  expect(existsSync(orphan.path)).toBe(false)
  expect(scan.database.query("SELECT id FROM attachments").all()).toEqual([{ id: shared.id }])
})

test("commits on a second SQLite connection also invalidate a collection pass", async () => {
  const scan = await makeScanFixture()
  const [shared, orphan] = makeOutputCandidates(scan, 2)
  if (!shared || !orphan) throw new Error("Missing synthetic candidates")
  const writer = new Database(scan.database.filename)
  scanCleanups.add(() => {
    writer.close()
  })

  const first = await collectUnusedOutputBlobs(scan.database, scan.root, Date.now(), async () => {
    writer
      .query(`INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at)
      VALUES ('external-reference','t','assistant','text','Synthetic',?,1,1)`)
      .run(JSON.stringify([{ ...tool(""), outputJson: null, outputAttachmentId: shared.id }]))
  })
  const second = await collectUnusedOutputBlobs(scan.database, scan.root)

  expect(first).toBe(0)
  expect(second).toBe(1)
  expect(existsSync(shared.path)).toBe(true)
  expect(existsSync(orphan.path)).toBe(false)
})

const makeScheduledMaintenance = (
  scan: Awaited<ReturnType<typeof makeScanFixture>>,
  yieldBatch: () => Promise<void>,
  runStage: PerformanceStageRunner,
  attachmentReferenceTimeoutMs = 10 * 60_000,
) => {
  // Only this fixture owns the next callback; tests advance it without waiting a day.
  let scheduled: { action: () => Promise<void>; delay: number; timer: ReturnType<typeof setTimeout> } | undefined
  let errors = 0
  const logs: string[] = []
  const maintenance = createStorageMaintenance({
    database: scan.database,
    appData: scan.root,
    publishResync: () => {},
    retryDeletedBrowserSessionKeys: async () => {},
    onError: () => {
      errors += 1
    },
    yieldBatch,
    runStage,
    attachmentReferenceTimeoutMs,
    log: ({ msg }) => logs.push(msg),
    schedule: (action, delay) => {
      const timer = setTimeout(() => {}, 86400_000)
      timer.unref()
      scheduled = { action, delay, timer }
      return timer
    },
  })
  scanCleanups.add(maintenance.dispose)
  const getNextDelay = () => scheduled?.delay

  return {
    maintenance,
    getErrors: () => errors,
    getLogs: () => logs,
    getNextDelay,
    runNext: async () => {
      // Compaction and retention can require several short preparation ticks.
      for (let pass = 0; pass < 100; pass++) {
        const next = scheduled
        if (!next) throw new Error("Missing maintenance callback")
        clearTimeout(next.timer)
        scheduled = undefined
        await next.action()
        if ((getNextDelay() ?? 0) >= 1000) return
      }
      throw new Error("Maintenance did not finish its bounded preparation")
    },
  }
}

test("a slow cold reference scan resumes after a deadline and logs each deferred pass", async () => {
  const scan = await makeScanFixture()
  const [orphan] = makeOutputCandidates(scan, 1)
  if (!orphan) throw new Error("Missing synthetic candidate")
  const insert = scan.database.query(`INSERT INTO send_journal(
    thread_id,client_nonce,request_json,message_id,deadline,status,created_at,updated_at
  ) VALUES ('t',?,'{}',?,0,'acked',1,1)`)
  scan.database.transaction(() => {
    Array.from({ length: 150 }, (_, index) => index).forEach((index) => {
      insert.run(`nonce-${index}`, `message-${index}`)
    })
  })()
  let scanning = false
  let delayMs = 60
  const scheduled = makeScheduledMaintenance(
    scan,
    async () => {
      if (scanning) await Bun.sleep(delayMs)
    },
    (stage, action, input) => {
      if (stage === "storage_attachment_reference_scan") scanning = true
      return scan.stages.run(stage, action, input)
    },
    50,
  )

  await scheduled.runNext()

  expect(scheduled.getNextDelay()).toBe(1000)
  expect(scheduled.getLogs()).toContain("Limpeza de anexos adiada após o prazo da leitura de referências")
  expect(existsSync(orphan.path)).toBe(true)

  delayMs = 30
  await scheduled.runNext()

  expect(scheduled.maintenance.snapshot().running).toBe(false)
  expect(existsSync(orphan.path)).toBe(false)
})

test("a commit after the reference worker reads a batch defers without an error and rescans safely", async () => {
  const scan = await makeScanFixture()
  const [shared, orphan] = makeOutputCandidates(scan, 2)
  if (!shared || !orphan) throw new Error("Missing synthetic candidates")
  insert(scan, "seed", [])
  const writer = new Database(scan.database.filename)
  scanCleanups.add(() => {
    writer.close()
  })
  let scanning = false
  let commits = 0
  const scheduled = makeScheduledMaintenance(
    scan,
    async () => {
      if (!scanning || commits) return
      writer
        .query(`INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at)
        VALUES ('worker-reference','t','assistant','text','Synthetic',?,?,?)`)
        .run(JSON.stringify([{ ...tool(""), outputJson: null, outputAttachmentId: shared.id }]), Date.now(), Date.now())
      commits += 1
    },
    (stage, action, input) => {
      if (stage === "storage_attachment_reference_scan") scanning = true
      return scan.stages.run(stage, action, input)
    },
  )

  await scheduled.runNext()

  expect(commits).toBe(1)
  expect(scheduled.getNextDelay()).toBe(1000)
  expect(scheduled.getErrors()).toBe(0)
  expect(scheduled.maintenance.snapshot().error).toBeUndefined()
  expect(existsSync(shared.path)).toBe(true)
  expect(existsSync(orphan.path)).toBe(true)

  await scheduled.runNext()

  expect(scheduled.getErrors()).toBe(0)
  expect(scheduled.maintenance.snapshot()).toMatchObject({ running: false })
  expect(scheduled.maintenance.snapshot().error).toBeUndefined()
  expect(scan.database.query("SELECT id FROM attachments").all()).toEqual([{ id: shared.id }])
  expect(existsSync(shared.path)).toBe(true)
  expect(existsSync(orphan.path)).toBe(false)
})

test("repeated worker deferrals back off to a cap and return to the daily schedule", async () => {
  const scan = await makeScanFixture()
  makeOutputCandidates(scan, 1)
  insert(scan, "seed", [])
  const writer = new Database(scan.database.filename)
  scanCleanups.add(() => {
    writer.close()
  })
  let scanning = false
  const scheduled = makeScheduledMaintenance(
    scan,
    async () => {
      if (!scanning) return
      writer.query("UPDATE messages SET text = text || '.' WHERE id = 'seed'").run()
    },
    (stage, action, input) => {
      if (stage === "storage_message_compaction_batch") scanning = false
      if (stage === "storage_attachment_reference_scan") scanning = true
      return scan.stages.run(stage, action, input)
    },
  )

  for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 86400_000]) {
    await scheduled.runNext()

    expect(scheduled.getNextDelay()).toBe(delay)
    expect(scheduled.getErrors()).toBe(0)
    expect(scheduled.maintenance.snapshot().error).toBeUndefined()
  }

  expect(scheduled.maintenance.snapshot().running).toBe(false)
  expect(scan.database.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 })

  await scheduled.runNext()

  expect(scheduled.getNextDelay()).toBe(1000)
})
