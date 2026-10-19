import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openDatabase } from "../../src/kernel/db"

const canRunSyncBenchmark = process.platform === "linux" && Bun.which("cc") !== null
const compilerPath = Bun.which("cc")
const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const syncShim = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef int (*SyncFunction)(int);

static atomic_int recording = 0;
static atomic_int sync_count = 0;
static atomic_int sync_delay_ms = 20;
static atomic_int sqlite_only = 0;

static int is_sqlite_file(int descriptor) {
  char descriptor_path[64];
  char path[4096];
  snprintf(descriptor_path, sizeof(descriptor_path), "/proc/self/fd/%d", descriptor);
  const ssize_t length = readlink(descriptor_path, path, sizeof(path) - 1);
  if (length < 0) return 0;
  path[length] = 0;
  return strstr(path, ".db") != NULL;
}

static int delay_sync(const char *name, int descriptor) {
  SyncFunction original = (SyncFunction)dlsym(RTLD_NEXT, name);
  if (!original) {
    errno = ENOSYS;
    return -1;
  }
  if (atomic_load(&recording) && (!atomic_load(&sqlite_only) || is_sqlite_file(descriptor))) {
    const int delay_ms = atomic_load(&sync_delay_ms);
    struct timespec delay = {delay_ms / 1000, (delay_ms % 1000) * 1000 * 1000};
    atomic_fetch_add(&sync_count, 1);
    nanosleep(&delay, NULL);
  }
  return original(descriptor);
}

int fsync(int descriptor) { return delay_sync("fsync", descriptor); }
int fdatasync(int descriptor) { return delay_sync("fdatasync", descriptor); }

int touri_start_sync_recording(void) {
  atomic_store(&sync_count, 0);
  atomic_store(&recording, 1);
  return 0;
}

int touri_set_sqlite_only(int enabled) {
  atomic_store(&sqlite_only, enabled);
  return 0;
}

int touri_set_sync_delay_ms(int delay_ms) {
  atomic_store(&sync_delay_ms, delay_ms);
  return 0;
}

int touri_stop_sync_recording(void) {
  atomic_store(&recording, 0);
  return atomic_load(&sync_count);
}
`

const benchmark = `import { Database } from "bun:sqlite";
import { dlopen } from "bun:ffi";
import { join } from "node:path";

const directory = process.env.TOURI_BENCH_DIR;
const shimPath = process.env.TOURI_SYNC_SHIM;
if (!directory || !shimPath) throw new Error("Benchmark paths are missing");

const library = dlopen(shimPath, {
  touri_start_sync_recording: { args: [], returns: "i32" },
  touri_stop_sync_recording: { args: [], returns: "i32" },
});

const run = (mode, synchronous) => {
  const database = new Database(join(directory, mode + ".db"), { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE records (value INTEGER NOT NULL)");
  database.exec("PRAGMA synchronous = " + synchronous);
  const insert = database.query("INSERT INTO records(value) VALUES (?)");
  insert.run(-1);
  library.symbols.touri_start_sync_recording();
  const startedAt = performance.now();
  // Keep one synchronous commit per row to isolate the cost paid by stream batches.
  for (let index = 0; index < 32; index++) insert.run(index);
  const elapsedMs = performance.now() - startedAt;
  const syncCalls = library.symbols.touri_stop_sync_recording();
  database.close();
  return { mode, transactions: 32, syncCalls, elapsedMs: Math.round(elapsedMs) };
};

console.log(JSON.stringify({ full: run("full", 2), normal: run("normal", 1) }));
`

test.skipIf(!canRunSyncBenchmark)(
  "WAL NORMAL batches avoid per-commit fsync latency under a slow sync shim",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "touri-sqlite-sync-"))
    cleanups.add(() => rm(root, { recursive: true, force: true }))
    const sourcePath = join(root, "slow-sync.c")
    const shimPath = join(root, "slow-sync.so")
    await writeFile(sourcePath, syncShim)
    if (!compilerPath) throw new Error("A C compiler is required for the sync benchmark")

    const compiler = Bun.spawn({
      cmd: [compilerPath, "-std=c11", "-shared", "-fPIC", "-o", shimPath, sourcePath, "-ldl"],
      stdout: "ignore",
      stderr: "pipe",
    })
    const [compilerExit, compilerError] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()])
    if (compilerExit !== 0) throw new Error(`Could not compile the sync shim: ${compilerError}`)

    const child = Bun.spawn({
      cmd: [process.execPath, "-e", benchmark],
      cwd: root,
      env: {
        HOME: root,
        LD_PRELOAD: shimPath,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: root,
        TOURI_BENCH_DIR: root,
        TOURI_SYNC_SHIM: shimPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [childExit, output, childError] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (childExit !== 0) throw new Error(`The sync benchmark failed: ${childError}`)

    const measured = JSON.parse(output) as {
      full: { transactions: number; syncCalls: number; elapsedMs: number }
      normal: { transactions: number; syncCalls: number; elapsedMs: number }
    }
    console.info(`sqlite-sync-benchmark ${JSON.stringify({ delayMsPerSync: 20, ...measured })}`)

    expect(measured.full.syncCalls).toBeGreaterThanOrEqual(measured.full.transactions)
    expect(measured.normal.syncCalls).toBeLessThanOrEqual(1)
    expect(measured.normal.elapsedMs).toBeLessThan(250)
    expect(measured.normal.elapsedMs).toBeLessThan(measured.full.elapsedMs / 3)
  },
  15_000,
)

const workerBenchmark = `import { Database } from "bun:sqlite";
import { dlopen } from "bun:ffi";
import { join } from "node:path";
const { createKernel } = await import(process.env.TOURI_KERNEL);
const { init } = await import(process.env.TOURI_STORE);
const { createRuntimeEngine } = await import(process.env.TOURI_ENGINE);
const { writeDatabaseAsync } = await import(process.env.TOURI_DATABASE_WRITE);
const { streamPersistenceWorkerSource } = await import(process.env.TOURI_STREAM_WORKER);
const library = dlopen(process.env.TOURI_SYNC_SHIM, {
  touri_start_sync_recording: { args: [], returns: "i32" },
  touri_stop_sync_recording: { args: [], returns: "i32" },
  touri_set_sync_delay_ms: { args: ["i32"], returns: "i32" },
  touri_set_sqlite_only: { args: ["i32"], returns: "i32" },
});
const measure = async (operation) => {
  let maxLagMs = 0;
  let samples = 0;
  let expectedAt = performance.now() + 5;
  const probe = setInterval(() => {
    maxLagMs = Math.max(maxLagMs, performance.now() - expectedAt);
    expectedAt = performance.now() + 5;
    samples += 1;
  }, 5);
  const startedAt = performance.now();
  await operation();
  await Bun.sleep(10);
  clearInterval(probe);
  return { latencyMs: Math.round(performance.now() - startedAt), maxLagMs: Math.round(maxLagMs), samples };
};
const beforeDatabase = new Database(process.env.TOURI_BEFORE_DB);
beforeDatabase.exec("PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0");
library.symbols.touri_set_sync_delay_ms(200);
library.symbols.touri_start_sync_recording();
const before = await measure(() => beforeDatabase.transaction(() => {
  Array.from({ length: 32 }).forEach((_, index) => {
    beforeDatabase.query("UPDATE threads SET updated_seq = updated_seq + 1 WHERE id = 'thread'").run();
    beforeDatabase.query("INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at) VALUES ('thread',?,1,?,1)")
      .run(index + 2, JSON.stringify({ type: "message.delta", threadId: "thread", messageId: "reply", partIndex: 0, delta: "x", offset: index }));
  });
}).immediate());
before.syncCalls = library.symbols.touri_stop_sync_recording();
beforeDatabase.close();
library.symbols.touri_set_sqlite_only(1);

const directory = join(process.env.TOURI_BENCH_DIR, "production");
const runtime = createKernel({ appData: directory });
runtime.kernel.services.use("storage.maintenance")?.dispose();
const database = runtime.kernel.db;
const locked = Promise.withResolvers();
const workerUrls = [];
await init(runtime.kernel, undefined, () => {
  const source = streamPersistenceWorkerSource.replace(
    "database.transaction(() => writeBatch(data.batch)).immediate()",
    'database.transaction(() => { if (data.batch.events.some((event) => event.delta === "x".repeat(32))) { self.postMessage({ type: "test-locked" }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } return writeBatch(data.batch); }).immediate()',
  );
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  workerUrls.push(url);
  const worker = new Worker(url, { smol: true, ref: false });
  worker.addEventListener("message", ({ data }) => { if (data.type === "test-locked") locked.resolve(); });
  return worker;
});
database.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Synthetic','codex',?,1,1)").run(directory);
database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1)");
const store = runtime.kernel.services.use("store.api");
store.insertMessage({ message: {
  id: "request", threadId: "thread", parentId: null, role: "user", kind: "text", status: "complete", runId: null,
  text: "Synthetic request", parts: [], sender: null, source: "local",
} });
const turn = Promise.withResolvers();
let abortObserved = false;
const engine = createRuntimeEngine({ kernel: runtime.kernel, environment: { HOME: directory, PATH: "/usr/bin" }, providerAdapters: {
  codex: { provider: "codex", detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
    startTurn: async (args) => {
      args.onEvent({ type: "turn_started", externalTurnId: "synthetic-turn" });
      turn.resolve(args);
      await new Promise((resolve) => args.signal.addEventListener("abort", resolve, { once: true }));
      abortObserved = true;
      return { success: false, errorCode: "canceled", error: "Canceled" };
    }, answerApproval: async () => ({ success: true }), shutdown: async () => {},
  },
} });
const queued = engine.enqueue({ threadId: "thread", requestMessageId: "request", trigger: "user" });
if (!queued.success) throw new Error("Could not start synthetic turn");
const args = await turn.promise;
args.onEvent({ type: "text_delta", itemId: "text", delta: "warm" });
await store.flushWritesAsync();
library.symbols.touri_start_sync_recording();
let cancelLatencyMs = 0;
let mainWriteLatencyMs = 0;
const after = await measure(async () => {
  args.onEvent({ type: "text_delta", itemId: "text", delta: "x".repeat(32) });
  const drained = store.flushWritesAsync();
  await locked.promise;
  const writeStartedAt = performance.now();
  const mainWrite = writeDatabaseAsync(database, () => {
    const text = database.query("SELECT text FROM messages WHERE role = 'assistant'").get().text;
    database.query("INSERT INTO settings(key,value_json,updated_at) VALUES ('synthetic.concurrent',?,1)")
      .run(JSON.stringify(text));
  }).then(() => { mainWriteLatencyMs = Math.round(performance.now() - writeStartedAt); });
  const cancelStartedAt = performance.now();
  engine.cancel(queued.run.id);
  cancelLatencyMs = Math.round(performance.now() - cancelStartedAt);
  await Promise.all([drained, mainWrite]);
  const deadline = performance.now() + 5000;
  while (engine.listRuns("thread")[0]?.status !== "canceled") {
    if (performance.now() > deadline) throw new Error("Cancellation did not settle");
    await Bun.sleep(5);
  }
  await store.flushWritesAsync();
});
after.syncCalls = library.symbols.touri_stop_sync_recording();
after.cancelLatencyMs = cancelLatencyMs;
after.mainWriteLatencyMs = mainWriteLatencyMs;
after.abortObserved = abortObserved;
after.mainWrite = database.query("SELECT value_json FROM settings WHERE key='synthetic.concurrent'").get().value_json;
after.text = store.activePath({ threadId: "thread" }).find((message) => message.role === "assistant").text;
after.journalRows = database.query("SELECT COUNT(*) AS count FROM transcript_entries WHERE json_extract(event_json,'$.type')='message.delta'").get().count;
await engine.shutdown();
await runtime.stop();
workerUrls.forEach((url) => URL.revokeObjectURL(url));
console.log(JSON.stringify({ delayMs: 200, before, after }));
`

test.skipIf(!canRunSyncBenchmark)(
  "stream persistence commits off the event loop under a slow sync shim",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "touri-stream-sync-"))
    cleanups.add(() => rm(root, { recursive: true, force: true }))
    const sourcePath = join(root, "slow-sync.c")
    const shimPath = join(root, "slow-sync.so")
    const beforePath = join(root, "before.db")
    const afterPath = join(root, "after.db")
    await writeFile(sourcePath, syncShim)
    if (!compilerPath) throw new Error("A C compiler is required for the sync benchmark")
    for (const filename of [beforePath, afterPath]) getStreamBenchmarkDatabase(filename)

    const compiler = Bun.spawn({
      cmd: [compilerPath, "-std=c11", "-shared", "-fPIC", "-o", shimPath, sourcePath, "-ldl"],
      stdout: "ignore",
      stderr: "pipe",
    })
    const [compilerExit, compilerError] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()])
    if (compilerExit !== 0) throw new Error(`Could not compile the sync shim: ${compilerError}`)
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", workerBenchmark],
      cwd: root,
      env: {
        HOME: root,
        LD_PRELOAD: shimPath,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: root,
        TOURI_AFTER_DB: afterPath,
        TOURI_BENCH_DIR: root,
        TOURI_KERNEL: fileURLToPath(new URL("../../src/kernel/index.ts", import.meta.url)),
        TOURI_STORE: fileURLToPath(new URL("../../src/store/index.ts", import.meta.url)),
        TOURI_ENGINE: fileURLToPath(new URL("../../src/runtime/engine.ts", import.meta.url)),
        TOURI_DATABASE_WRITE: fileURLToPath(new URL("../../src/kernel/database-write.ts", import.meta.url)),
        TOURI_BEFORE_DB: beforePath,
        TOURI_STREAM_WORKER: fileURLToPath(new URL("../../src/store/stream-persistence-worker.ts", import.meta.url)),
        TOURI_SYNC_SHIM: shimPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [childExit, output, childError] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (childExit !== 0) throw new Error(`The stream sync benchmark failed: ${childError}`)
    const measured = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      before: { syncCalls: number; latencyMs: number; maxLagMs: number; samples: number }
      after: {
        latencyMs: number
        maxLagMs: number
        samples: number
        syncCalls: number
        cancelLatencyMs: number
        mainWriteLatencyMs: number
        mainWrite: string
        abortObserved: boolean
        journalRows: number
        text: string
      }
    }
    console.info(`stream-sync-benchmark ${JSON.stringify(measured)}`)

    expect(measured.before.syncCalls).toBeGreaterThanOrEqual(1)
    expect(measured.before.maxLagMs).toBeGreaterThan(100)
    expect(measured.after.latencyMs).toBeGreaterThan(200)
    expect(measured.after.samples).toBeGreaterThan(10)
    expect(measured.after.maxLagMs).toBeLessThan(50)
    expect(measured.after.cancelLatencyMs).toBeLessThan(50)
    expect(measured.after.mainWriteLatencyMs).toBeGreaterThan(100)
    expect(measured.after.mainWrite).toBe(JSON.stringify(`warm${"x".repeat(32)}`))
    expect(measured.after.abortObserved).toBe(true)
    expect(measured.after.journalRows).toBe(2)
    expect(measured.after.text).toBe(`warm${"x".repeat(32)}`)
  },
  15_000,
)

const getStreamBenchmarkDatabase = (filename: string): void => {
  const database = openDatabase({ filename })
  database
    .query(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Synthetic','codex','.',1,1)",
    )
    .run()
  database
    .query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1)")
    .run()
  database
    .query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
      VALUES ('reply','thread','assistant','text','streaming','','[{"type":"text","text":""}]',1,1)`)
    .run()
  database.close()
}
