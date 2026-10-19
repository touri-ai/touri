import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandPart, MessagePart, Run, StoreApi } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createToolResolutions } from "../../src/runtime/tool-resolutions"
import { init as initStore } from "../../src/store"

type BatchedStore = StoreApi & {
  appendParts?: (input: {
    threadId: string
    messageId: string
    parts: Array<{ partIndex: number; part: MessagePart }>
  }) => void
  flushWrites?: () => void
}

// With autocheckpoint disabled, each committed WAL frame has a nonzero database
// size in its header. This counts autocommits, nested transactions and trigger
// writes without relying on how the writer happens to call Database.transaction.
const walMetrics = (path: string): { commits: number; walBytes: number } => {
  const walBytes = statSync(path).size
  const fd = openSync(path, "r")
  try {
    const header = Buffer.alloc(32)
    expect(readSync(fd, header, 0, header.length, 0)).toBe(header.length)
    const pageSize = header.readUInt32BE(8)
    expect(pageSize).toBeGreaterThanOrEqual(512)
    const frameBytes = pageSize + 24
    expect((walBytes - header.length) % frameBytes).toBe(0)
    const frame = Buffer.alloc(24)
    let commits = 0
    for (let offset = header.length; offset < walBytes; offset += frameBytes) {
      expect(readSync(fd, frame, 0, frame.length, offset)).toBe(frame.length)
      if (frame.readUInt32BE(4) !== 0) commits++
    }
    return { commits, walBytes }
  } finally {
    closeSync(fd)
  }
}

// Persistent triggers observe logical row mutations on every SQLite connection, including the worker.
const recordRowWrites = (database: Database): void => {
  database.exec(
    "CREATE TABLE write_measurement (id INTEGER PRIMARY KEY, writes INTEGER NOT NULL); INSERT INTO write_measurement VALUES (1, 0)",
  )
  const tables = [
    "messages",
    "threads",
    "transcript_entries",
    "transcript_part_entries",
    "transcript_pending_deltas",
    "transcript_retention",
    "transcript_maintenance",
    "ui_event_log",
    "schema_meta",
    "stream_writer_state",
    "tool_resolutions",
    "tool_calls",
    "runs",
    "attachments",
    "message_search_rows",
  ]
  tables.forEach((table) => {
    ;["INSERT", "UPDATE", "DELETE"].forEach((operation) => {
      database.exec(`CREATE TRIGGER measure_${table}_${operation} AFTER ${operation} ON ${table}
        BEGIN UPDATE write_measurement SET writes = writes + 1 WHERE id = 1; END`)
    })
  })
}
const getRowWrites = (database: Database): number =>
  (database.query("SELECT writes FROM write_measurement WHERE id = 1").get() as { writes: number }).writes

test("long agentic turns bound durable commits, row mutations and physical WAL bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-write-amplification-"))
  const runtime = createKernel({ appData: root })
  try {
    await initStore(runtime.kernel)
    runtime.kernel.services.use("storage.maintenance")?.dispose()
    const database = runtime.kernel.db as Database
    database
      .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste',?,'/tmp',1,1)")
      .run(profileProviders[0])
    database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
    const store = runtime.kernel.services.use("store.api") as BatchedStore | undefined
    if (!store) throw new Error("Store missing")
    const persistence = createRuntimePersistence({ database })
    const run: Run = {
      id: "r",
      threadId: "t",
      botId: "b",
      provider: profileProviders[0],
      trigger: "user",
      requestMessageId: null,
      replyMessageId: "reply",
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: 1,
      startedAt: 1,
      finishedAt: null,
    }
    persistence.saveRun(run)
    let command: CommandPart = {
      type: "command",
      callId: "command",
      command: "printf output",
      cwd: "/tmp",
      exitCode: null,
      outputTail: "",
      resolution: "running",
    }
    expect(
      store.insertMessage({
        message: {
          id: "reply",
          threadId: "t",
          parentId: null,
          role: "assistant",
          kind: "text",
          status: "streaming",
          runId: run.id,
          text: "",
          parts: [{ type: "text", text: "" }, command],
          sender: null,
          source: "local",
        },
      }).success,
    ).toBe(true)
    const tools = createToolResolutions(runtime.kernel)
    const record = tools.record as (run: Run, part: CommandPart, recovering?: boolean, persist?: boolean) => CommandPart
    // The baseline mode deliberately exercises the old full-message publish
    // path on the same fixture; it reports measurements without applying budgets.
    const baseline = process.env.TOURI_WRITE_BASELINE === "1"
    const batched = !baseline && typeof store.appendParts === "function"
    const streamed: string[] = []
    let publishedProgress = 0
    runtime.kernel.subscribe(({ event }) => {
      if (event.type === "message.delta") streamed.push(event.delta)
      if (event.type === "message.parts") publishedProgress += event.parts.length
    })
    await store.flushWritesAsync?.()
    database.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)")
    recordRowWrites(database)
    const changesBefore = getRowWrites(database)
    const started = performance.now()
    const delta = "Resposta incremental. ".padEnd(64, ".")
    let text = ""
    let progress = 0
    for (let index = 0; index < 2_000; index++) {
      text += delta
      store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 0, delta })
      const target = Math.floor(((index + 1) * 300) / 2_000)
      if (target === progress) continue
      progress = target
      command = record(run, { ...command, outputTail: `${progress}: `.padEnd(12 * 1024, "x") }, false, !batched)
      if (batched) store.appendParts?.({ threadId: "t", messageId: "reply", parts: [{ partIndex: 1, part: command }] })
      else {
        const input = {
          threadId: "t",
          messageId: "reply",
          patch: { text, parts: [{ type: "text" as const, text }, command] },
        }
        if (store.updateMessageAsync) await store.updateMessageAsync(input)
        else {
          await store.flushWritesAsync?.()
          store.updateMessage(input)
        }
      }
    }
    await store.flushWritesAsync?.()
    // Finalization supplies a full snapshot; verify live delivery before that
    // snapshot could conceal a writer that silently dropped accepted work.
    expect(streamed.join("")).toBe(delta.repeat(2_000))
    if (batched) expect(publishedProgress).toBe(300)
    database.transaction(() => {
      const complete: Run = { ...run, status: "succeeded", finishedAt: Date.now() }
      command = record(complete, { ...command, exitCode: 0, resolution: "succeeded" })
      expect(
        store.updateMessage({
          threadId: "t",
          messageId: "reply",
          patch: { text, parts: [{ type: "text", text }, command], status: "complete" },
        }).success,
      ).toBe(true)
      persistence.saveRun(complete)
    })()
    await Bun.sleep(0)
    const elapsedMs = Math.round(performance.now() - started)
    const wal = walMetrics(join(root, "touri.db-wal"))
    const blobBytes = (database.query("SELECT COALESCE(SUM(bytes), 0) AS n FROM attachments").get() as { n: number }).n
    const metrics = {
      mode: baseline ? "baseline" : "batched",
      deltas: 2_000,
      progressUpdates: progress,
      ...wal,
      rowWrites: getRowWrites(database) - changesBefore,
      blobBytes,
      bytesWritten: wal.walBytes + blobBytes,
      elapsedMs,
    }
    console.info(`write-amplification ${JSON.stringify(metrics)}`)
    expect(metrics.progressUpdates).toBe(300)
    const reply = store.activePath({ threadId: "t" })[0]
    expect(reply?.text).toBe(delta.repeat(2_000))
    expect(reply?.status).toBe("complete")
    if (!baseline) {
      expect(metrics.commits).toBeLessThanOrEqual(350)
      expect(metrics.rowWrites).toBeGreaterThan(2_000)
      expect(metrics.rowWrites).toBeLessThanOrEqual(3_500)
      expect(metrics.bytesWritten).toBeLessThanOrEqual(32 * 1024 * 1024)
      expect(metrics.blobBytes).toBe(12 * 1024)
      expect(reply?.parts[1]).toMatchObject({ outputAttachmentId: expect.any(String), outputBytes: 12 * 1024 })
    }
  } finally {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
