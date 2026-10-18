import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
#include <time.h>

typedef int (*SyncFunction)(int);

static atomic_int recording = 0;
static atomic_int sync_count = 0;

static int delay_sync(const char *name, int descriptor) {
  SyncFunction original = (SyncFunction)dlsym(RTLD_NEXT, name);
  if (!original) {
    errno = ENOSYS;
    return -1;
  }
  if (atomic_load(&recording)) {
    struct timespec delay = {0, 20 * 1000 * 1000};
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
