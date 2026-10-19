import { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installDoctor } from "../../src/doctor"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { historyMigrationStatus } from "../../src/kernel/history-backfill"
import { materializeTranscript } from "../../src/kernel/transcript-storage"
import { initModules } from "../../src/main"

const headers = { Host: "127.0.0.1:0", Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }

// Synthetic history only. Six threads contain roughly 400–800 KB of message bodies.
const seedHistory = (filename: string, legacy = false): void => {
  const db = legacy ? new Database(filename) : openDatabase({ filename })
  if (legacy) {
    for (let n = 1; n <= 13; n++) {
      const sql = readFileSync(
        join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`),
        "utf8",
      )
      const messages = sql.indexOf("CREATE TABLE IF NOT EXISTS messages (")
      db.exec(
        messages < 0
          ? sql
          : sql.slice(0, messages) +
              sql
                .slice(messages)
                .replace("CHECK (source IN ('local','legacy'))", "CHECK (source IN ('local','previous-importer'))"),
      )
    }
  }
  const at = Date.now() - 60_000
  db.transaction(() => {
    for (let b = 0; b < 15; b++)
      db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,'codex','/tmp',?,?)").run(
        `bot-${b}`,
        `Bot ${b}`,
        at,
        at,
      )
    for (let t = 0; t < 134; t++) {
      const thread = `thread-${t}`
      const bot = `bot-${t % 15}`
      db.query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?,?,?, ?,?)").run(
        thread,
        bot,
        `Conversation ${t}`,
        at,
        at + t,
      )
      const count = t < 26 ? 12 : 11
      for (let m = 0; m < count; m++) {
        const id = `message-${m}`
        const run = `run-${t}-${m}`
        const text = "Synthetic history. ".repeat(t < 6 ? 900 + t * 180 : 180)
        db.query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,reply_message_id,queued_at,finished_at)
          VALUES (?,?,?,'codex','user','succeeded',?,?,?)`).run(run, thread, bot, id, at + m, at + m)
        db.query(`INSERT INTO messages(id,thread_id,parent_id,role,kind,status,run_id,text,parts_json,created_at,updated_at)
          VALUES (?,?,?,'assistant','text','complete',?,?,?,?,?)`).run(
          id,
          thread,
          m ? `message-${m - 1}` : null,
          run,
          text,
          JSON.stringify([{ type: "text", text }]),
          at + m,
          at + m,
        )
      }
      db.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(`message-${count - 1}`, thread)
    }
    // A normal shutdown has already published its durable transcript.
    db.exec(`UPDATE schema_meta SET value = (SELECT COALESCE(MAX(id),0) FROM transcript_entries)
      WHERE key = 'transcript_event_checkpoint'`)
  })()
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
}

test("profile a restart and initial workspace requests with 15 bots, 134 threads and 1500 messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-cold-start-"))
  let runtime: ReturnType<typeof createKernel> | undefined
  let request: (path: string) => Promise<Response> = async () => {
    throw new Error("Server not ready")
  }
  const serve = spyOn(Bun, "serve").mockImplementation((options) => {
    const server = { port: 0, stop: () => undefined, requestIP: () => null } as unknown as ReturnType<typeof Bun.serve>
    request = async (path) => {
      const response = await options.fetch?.call(
        server,
        new Request(`http://127.0.0.1:0/api/v1${path}`, { headers }),
        server,
      )
      if (!response) throw new Error("Missing HTTP response")
      return response
    }
    return server
  })
  try {
    const filename = join(root, "touri.db")
    seedHistory(filename)
    const size = statSync(filename).size
    const timings: Record<string, number> = {}
    let started = performance.now()
    const db = openDatabase({ filename })
    timings.openDatabase = performance.now() - started
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1500 })
    expect(historyMigrationStatus(db).running).toBe(false)
    started = performance.now()
    for (let i = 0; i < 134; i++) materializeTranscript(db)
    timings.repeatedProjectionRecovery = performance.now() - started
    db.close()
    started = performance.now()
    runtime = createKernel({ appData: root })
    timings.createKernel = performance.now() - started
    const kernel = runtime.kernel
    // A stuck probe must not hold startup or the real diagnostic route open.
    const doctor = installDoctor(
      kernel,
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve([]), { once: true })
        }),
    )
    const log = kernel.log
    let previous = performance.now()
    kernel.log = (entry) => {
      if (entry.module === "main") {
        timings[entry.msg] = performance.now() - previous
        if (entry.data) {
          timings[`${entry.msg} (load)`] = Number(entry.data.loadMs ?? 0)
          timings[`${entry.msg} (init)`] = Number(entry.data.initMs ?? 0)
        }
        previous = performance.now()
        if (entry.msg === "initialized module ./store/index.ts") {
          // Slow diagnostics must remain independent of startup and snapshots.
          kernel.services.use("doctor")?.dispose()
          kernel.services.provide("doctor", doctor)
        }
      }
      log(entry)
    }
    await initModules(runtime)
    timings.ready = performance.now() - started
    for (const path of ["/bots", "/doctor", "/machines", "/health", "/settings"]) {
      const requestStarted = performance.now()
      const response = await request(path)
      expect(response.status).toBe(200)
      await response.json()
      timings[path] = performance.now() - requestStarted
    }
    started = performance.now()
    await Promise.all(
      Array.from({ length: 15 }, async (_, b) => {
        const response = await request(`/bots/bot-${b}/threads`)
        expect(response.status).toBe(200)
        await response.json()
      }),
    )
    timings.threadLists = performance.now() - started
    started = performance.now()
    const selectedHistory = await (await request("/threads/thread-120/messages?all=true")).text()
    JSON.parse(selectedHistory)
    timings.selectedHistory = performance.now() - started
    started = performance.now()
    let bytes = 0
    await Promise.all(
      Array.from({ length: 134 }, async (_, t) => {
        const [messages, runs] = await Promise.all([
          request(`/threads/thread-${t}/messages?all=true`),
          request(`/threads/thread-${t}/runs?all=true`),
        ])
        expect(messages.status).toBe(200)
        expect(runs.status).toBe(200)
        const payload = await messages.text()
        bytes += payload.length
        JSON.parse(payload)
        await runs.json()
      }),
    )
    timings.allHistory = performance.now() - started
    console.info(
      JSON.stringify({
        databaseBytes: size,
        historyBytes: bytes,
        selectedHistoryBytes: selectedHistory.length,
        ms: timings,
      }),
    )
    expect(timings.repeatedProjectionRecovery).toBeLessThan(500)
    const store = kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    store.insertMessage({
      message: {
        id: "pending-reply",
        threadId: "thread-0",
        parentId: null,
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
    store.appendDelta({ threadId: "thread-0", messageId: "pending-reply", partIndex: 0, delta: "Recovered " })
    store.appendDelta({ threadId: "thread-0", messageId: "pending-reply", partIndex: 0, delta: "in order" })
    await store.flushWritesAsync?.()
    const projection = () => (kernel.db as Database).query("SELECT text FROM messages WHERE id = 'pending-reply'").get()
    expect(projection()).toEqual({ text: "Recovered in order" })
    materializeTranscript(kernel.db as Database)
    expect(projection()).toEqual({ text: "Recovered in order" })
    materializeTranscript(kernel.db as Database)
    expect(projection()).toEqual({ text: "Recovered in order" })
    expect((kernel.db as Database).query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    if (runtime) {
      await runtime.kernel.services.use("runtime.shutdown")?.()
      runtime.emitHostNotification({ method: "app.willQuit", params: {} })
      await runtime.kernel.services.use("vm.shutdown")?.()
      await runtime.stop()
    }
    serve.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("the source table rebuild and page reclamation run only on the first upgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-cold-upgrade-"))
  let database: Database | undefined
  const execute = Database.prototype.exec
  let rebuilds = 0
  let vacuums = 0
  let vacuumMs = 0
  const exec = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
    if (sql.startsWith('CREATE TABLE "messages_legacy_source"')) rebuilds++
    const started = performance.now()
    const result = execute.call(this, sql)
    if (sql === "VACUUM") {
      vacuums++
      vacuumMs += performance.now() - started
    }
    return result
  })
  try {
    const filename = join(root, "touri.db")
    seedHistory(filename, true)
    const started = performance.now()
    database = openDatabase({ filename })
    const upgradeMs = performance.now() - started
    expect(rebuilds).toBe(1)
    expect(vacuums).toBe(1)
    expect(database.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1500 })
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    database.close()
    const reopened = performance.now()
    database = openDatabase({ filename })
    const reopenMs = performance.now() - reopened
    expect(rebuilds).toBe(1)
    expect(vacuums).toBe(1)
    console.info(JSON.stringify({ upgradeMs, vacuumMs, reopenMs, rebuilds, vacuums }))
  } finally {
    database?.close()
    exec.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
