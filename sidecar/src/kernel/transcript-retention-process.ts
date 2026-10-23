import { constants, Database } from "bun:sqlite"
import { lstat, realpath } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { applyTranscriptRetentionPlan, getTranscriptRetentionPlan } from "./transcript-storage"

type RetentionRequest = { filename: string; dev: number; ino: number; cursor: number; manual: boolean }

/** Private, one-batch helper. No server, configuration, user SQL or diagnostics. */
export const runTranscriptRetention = async (): Promise<void> => {
  let database: Database | undefined
  let watchdog: Worker | undefined
  let workerUrl: string | undefined
  try {
    // The independent thread can interrupt native SQLite even when both calling loops wait on I/O.
    const lease = new Int32Array(new SharedArrayBuffer(8))
    workerUrl = URL.createObjectURL(new Blob([watchdogSource], { type: "application/javascript" }))
    watchdog = new Worker(workerUrl, { smol: true })
    const ready = Promise.withResolvers<void>()
    watchdog.onmessage = () => ready.resolve()
    watchdog.onerror = (event) => {
      event.preventDefault()
      ready.reject(new Error("RETENTION_FAILED"))
    }
    watchdog.postMessage({ lease: lease.buffer, pid: process.pid, parent: process.ppid })
    await ready.promise
    const input = await getRequest()
    const stat = await lstat(input.filename)
    const canonical = await realpath(input.filename)
    if (canonical !== input.filename || !stat.isFile() || stat.dev !== input.dev || stat.ino !== input.ino)
      throw new Error("RETENTION_FAILED")

    database = new Database(input.filename, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW)
    database.exec(
      "PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-8192",
    )
    const mode = database.query("PRAGMA journal_mode").get() as { journal_mode: string }
    if (mode.journal_mode !== "wal") throw new Error("RETENTION_FAILED")

    const options = input.manual ? { database, events: 0, entriesPerThread: 0, maxAgeMs: 0 } : { database }
    const plan = getTranscriptRetentionPlan(options, input.cursor, 32)
    if (!plan) {
      process.stdout.write('{"more":false,"cursor":0}\n')
      return
    }
    Atomics.store(lease, 1, (Date.now() + 40) | 0)
    Atomics.store(lease, 0, 1)
    const result = applyTranscriptRetentionPlan(database, plan)
    Atomics.store(lease, 0, 0)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.exitCode = isSqliteBusy(error) ? 75 : 1
  } finally {
    watchdog?.terminate()
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    database?.close()
  }
}

const getRequest = async (): Promise<RetentionRequest> => {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > 4096) throw new Error("RETENTION_FAILED")
    text += decoder.decode(next.value, { stream: true })
  }
  const input = JSON.parse(text + decoder.decode()) as RetentionRequest
  if (
    typeof input.filename !== "string" ||
    resolve(input.filename) !== input.filename ||
    dirname(input.filename) !== resolve(process.env.TOURI_APP_DATA ?? "") ||
    !Number.isSafeInteger(input.cursor) ||
    input.cursor < 0 ||
    typeof input.manual !== "boolean" ||
    !Number.isSafeInteger(input.dev) ||
    !Number.isSafeInteger(input.ino)
  )
    throw new Error("RETENTION_FAILED")
  return input
}

const isSqliteBusy = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))

// This thread owns only its helper's lifetime. A killed writer leaves an atomic WAL rollback.
const watchdogSource = `self.onmessage = ({data}) => {
  const lease = new Int32Array(data.lease);
  const started = Date.now();
  setInterval(() => {
    let orphan = false;
    try { process.kill(data.parent, 0); } catch { orphan = true; }
    const expired = Atomics.load(lease, 0) === 1 && ((Date.now() | 0) - Atomics.load(lease, 1) | 0) >= 0;
    if (expired || orphan || Date.now() - started > 14000) process.kill(data.pid, "SIGKILL");
  }, 2);
  self.postMessage("ready");
};`

if (import.meta.main) await runTranscriptRetention()
