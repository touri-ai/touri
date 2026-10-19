import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openDatabase } from "../../src/kernel/db"
import { syncShim } from "../fakes/slow-sync"

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

const benchmark = `import { Database } from "bun:sqlite";
import { dlopen } from "bun:ffi";
import { join } from "node:path";

const directory = process.env.TOURI_BENCH_DIR;
const shimPath = process.env.TOURI_SYNC_SHIM;
if (!directory || !shimPath) throw new Error("Benchmark paths are missing");

const library = dlopen(shimPath, {
  touri_start_sync_recording: { args: [], returns: "i32" },
  touri_stop_sync_recording: { args: [], returns: "i32" },
  touri_set_sync_delay_ms: { args: ["i32"], returns: "i32" },
  touri_set_sqlite_only: { args: ["i32"], returns: "i32" },
  touri_get_sync_count: { args: [], returns: "i32" },
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

const runAuthentication = async () => {
  const { openAuthStore, lastSeenGranularityMs } = await import(process.env.TOURI_AUTH_STORE_MODULE);
  const { createWebGate } = await import(process.env.TOURI_WEB_GATE_MODULE);
  const { createRateLimiter } = await import(process.env.TOURI_RATE_LIMITER_MODULE);
  const baseline = new Database(join(directory, "auth-main-thread.db"), { create: true });
  baseline.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE devices (last_seen_at INTEGER NOT NULL)",
  );
  baseline.query("INSERT INTO devices (last_seen_at) VALUES (0)").run();
  library.symbols.touri_set_sqlite_only(1);
  library.symbols.touri_set_sync_delay_ms(200);
  library.symbols.touri_start_sync_recording();
  const baselineStartedAt = performance.now();
  baseline.query("UPDATE devices SET last_seen_at = ?").run(1);
  const baselineRequestElapsedMs = Math.round(performance.now() - baselineStartedAt);
  const baselineSyncCalls = library.symbols.touri_stop_sync_recording();
  baseline.close();
  if (baselineSyncCalls === 0) throw new Error("The main-thread FULL write did not hit the delayed fsync");

  const clock = { now: Date.now() };
  const store = await openAuthStore({ filename: join(directory, "auth-worker.db"), now: () => clock.now });
  const firstCode = await store.createPairingCode();
  const firstDevice = await store.claimPairingCode({ code: firstCode.code, deviceName: "Synthetic browser" });
  if (!firstDevice.success) throw new Error("Could not create the synthetic device");
  const gate = createWebGate({
    store,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
    ui: { source: "embedded", get: () => null },
    secrets: { keyOrigin: "env", get: () => null, set: () => {}, delete: () => {} },
  });

  library.symbols.touri_set_sqlite_only(1);
  library.symbols.touri_set_sync_delay_ms(200);
  library.symbols.touri_start_sync_recording();
  clock.now += lastSeenGranularityMs + 1;
  const requestStartedAt = performance.now();
  const url = new URL("http://127.0.0.1/api/v1/session");
  const request = new Request(url, {
    headers: { host: url.host, authorization: "Bearer " + firstDevice.token, "x-touri-client": "benchmark" },
  });
  const response = await gate({ request, url, clientIp: "127.0.0.1" });
  const requestElapsedMs = Math.round(performance.now() - requestStartedAt);
  if (response?.status !== 200) throw new Error("The synthetic authenticated request was rejected");
  const syncDeadline = performance.now() + 2_000;
  while (library.symbols.touri_get_sync_count() === 0 && performance.now() < syncDeadline)
    await new Promise((resolve) => setTimeout(resolve, 1));
  if (library.symbols.touri_get_sync_count() === 0) throw new Error("The delayed last-seen fsync did not start");
  const timerStartedAt = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const eventLoopElapsedMs = Math.round(performance.now() - timerStartedAt);

  const createBefore = library.symbols.touri_get_sync_count();
  const secondCode = await store.createPairingCode();
  const createSyncCalls = library.symbols.touri_get_sync_count() - createBefore;
  const claimBefore = library.symbols.touri_get_sync_count();
  const secondDevice = await store.claimPairingCode({ code: secondCode.code, deviceName: "Synthetic phone" });
  const claimSyncCalls = library.symbols.touri_get_sync_count() - claimBefore;
  if (!secondDevice.success) throw new Error("Could not durably claim the synthetic pairing code");
  const revokeBefore = library.symbols.touri_get_sync_count();
  const revoked = await store.revokeDevice(secondDevice.device.id);
  const revokeSyncCalls = library.symbols.touri_get_sync_count() - revokeBefore;
  if (!revoked.success) throw new Error("Could not durably revoke the synthetic device");
  await store.close();
  const reopened = await openAuthStore({ filename: join(directory, "auth-worker.db"), now: () => clock.now });
  const revokedTokenRejected = reopened.verifyDeviceToken(secondDevice.token) === null;
  const revokedDeviceListed = reopened.listDevices().some(
    (device) => device.id === secondDevice.device.id && device.revokedAt !== null,
  );
  const spentCodesRejected =
    !(await reopened.claimPairingCode({ code: secondCode.code, deviceName: "Replay" })).success &&
    !(await reopened.claimPairingCode({ code: firstCode.code, deviceName: "Replay" })).success;
  await reopened.close();

  return {
    baselineRequestElapsedMs,
    requestElapsedMs,
    eventLoopElapsedMs,
    durableSyncCalls: { create: createSyncCalls, claim: claimSyncCalls, revoke: revokeSyncCalls },
    durabilityVerified: revokedTokenRejected && revokedDeviceListed && spentCodesRejected,
  };
};

console.log(JSON.stringify({ full: run("full", 2), normal: run("normal", 1), authentication: await runAuthentication() }));
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

    const authStoreModule = new URL("../../src/cli/auth/store.ts", import.meta.url).href
    const webGateModule = new URL("../../src/cli/web/gate.ts", import.meta.url).href
    const rateLimiterModule = new URL("../../src/cli/auth/rateLimit.ts", import.meta.url).href
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
        TOURI_AUTH_STORE_MODULE: authStoreModule,
        TOURI_WEB_GATE_MODULE: webGateModule,
        TOURI_RATE_LIMITER_MODULE: rateLimiterModule,
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
      authentication: {
        baselineRequestElapsedMs: number
        requestElapsedMs: number
        eventLoopElapsedMs: number
        durableSyncCalls: { create: number; claim: number; revoke: number }
        durabilityVerified: boolean
      }
    }
    console.info(`sqlite-sync-benchmark ${JSON.stringify({ delayMsPerSync: 200, ...measured })}`)

    expect(measured.full.syncCalls).toBeGreaterThanOrEqual(measured.full.transactions)
    expect(measured.normal.syncCalls).toBeLessThanOrEqual(1)
    expect(measured.normal.elapsedMs).toBeLessThan(250)
    expect(measured.normal.elapsedMs).toBeLessThan(measured.full.elapsedMs / 3)
    expect(measured.authentication.baselineRequestElapsedMs).toBeGreaterThanOrEqual(150)
    expect(measured.authentication.requestElapsedMs).toBeLessThan(50)
    expect(measured.authentication.eventLoopElapsedMs).toBeLessThan(50)
    expect(measured.authentication.durableSyncCalls.create).toBeGreaterThanOrEqual(1)
    expect(measured.authentication.durableSyncCalls.claim).toBeGreaterThanOrEqual(1)
    expect(measured.authentication.durableSyncCalls.revoke).toBeGreaterThanOrEqual(1)
    expect(measured.authentication.durabilityVerified).toBe(true)
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
const outputMessage = store.insertMessage({ message: {
  id: "output", threadId: "thread", parentId: "request", role: "user", kind: "text", status: "complete", runId: null,
  text: "Synthetic output", parts: [], sender: null, source: "local",
} });
if (!outputMessage.success) throw new Error("Could not create the synthetic output message");
library.symbols.touri_set_sqlite_only(0);
library.symbols.touri_start_sync_recording();
const output = await measure(async () => {
  const result = await store.updateMessageAsync({
    threadId: "thread", messageId: "output", patch: {
      parts: [{ type: "tool_call", callId: "blob", tool: "read", summary: "", inputJson: "{}", outputJson: "x".repeat(16 * 1024), ok: true }],
    },
  });
  if (!result?.success) throw new Error("Could not save the synthetic output message");
});
output.syncCalls = library.symbols.touri_stop_sync_recording();
output.outputAttachmentId = JSON.parse(database.query("SELECT parts_json FROM messages WHERE id = 'output'").get().parts_json)[0].outputAttachmentId;
library.symbols.touri_set_sqlite_only(1);
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
console.log(JSON.stringify({ delayMs: 200, before, after, output }));
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
      output: { latencyMs: number; maxLagMs: number; samples: number; syncCalls: number; outputAttachmentId: string }
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
    expect(measured.output.syncCalls).toBeGreaterThanOrEqual(1)
    expect(measured.output.latencyMs).toBeGreaterThanOrEqual(150)
    expect(measured.output.maxLagMs).toBeLessThan(50)
    expect(measured.output.samples).toBeGreaterThan(10)
    expect(measured.output.outputAttachmentId).toMatch(/^[a-f0-9]{64}$/)
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
