import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { syncShim } from "../fakes/slow-sync"

const compilerPath = Bun.which("cc")
const canRunSyncBenchmark = process.platform === "linux" && compilerPath !== null
const cleanups = new Set<() => Promise<unknown>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const fileIoBenchmark = `import { dlopen } from "bun:ffi";
import { join } from "node:path";
const { appendLogFileAsync, writePrivateFileAsync, flushFileIoAsync, closeFileIoAsync, getFileIoStats } = await import(process.env.TOURI_FILES);
const root = process.env.TOURI_BENCH_DIR;
const path = join(root, "large.log");
await Bun.write(path, "x".repeat(8 * 1024 * 1024));
await writePrivateFileAsync({ root, path: join(root, "warmup"), content: "warm" });
await appendLogFileAsync({ root, path, content: Buffer.from("warm\\n"), maxBytes: 10 * 1024 * 1024, retainedGenerations: 2 });
const library = dlopen(process.env.TOURI_SYNC_SHIM, {
  touri_start_sync_recording: { args: [], returns: "i32" },
  touri_stop_sync_recording: { args: [], returns: "i32" },
  touri_set_sync_delay_ms: { args: ["i32"], returns: "i32" },
});
library.symbols.touri_set_sync_delay_ms(200);
library.symbols.touri_start_sync_recording();
const logs = Array.from({ length: 200 }, (_, index) => appendLogFileAsync({
  root, path, content: Buffer.from("synthetic-" + index + "\\n"), maxBytes: 10 * 1024 * 1024, retainedGenerations: 2,
}));
const pending = getFileIoStats().background.pending;
const timerStarted = performance.now();
const timer = Bun.sleep(10).then(() => Math.round(performance.now() - timerStarted));
const started = performance.now();
await writePrivateFileAsync({ root, path: join(root, "settings.json"), content: '{"synthetic":true}' });
const requestMs = Math.round(performance.now() - started);
const timerMs = await timer;
await Promise.all(logs);
await flushFileIoAsync();
const syncCalls = library.symbols.touri_stop_sync_recording();
await closeFileIoAsync();
const content = await Bun.file(path).text();
console.log(JSON.stringify({ requestMs, timerMs, pending, syncCalls, complete: content.endsWith("synthetic-199\\n") }));
`

test.skipIf(!canRunSyncBenchmark)(
  "request writes bypass 200 log appends with 200 ms fsync and an 8 MiB log",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "touri-file-sync-"))
    cleanups.add(() => rm(root, { recursive: true, force: true }))
    const sourcePath = join(root, "slow-sync.c")
    const shimPath = join(root, "slow-sync.so")
    await writeFile(sourcePath, syncShim)
    if (!compilerPath) throw new Error("A C compiler is required for the sync benchmark")
    const compiler = Bun.spawn([compilerPath, "-std=c11", "-shared", "-fPIC", "-o", shimPath, sourcePath, "-ldl"], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const [compilerExit, compilerError] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()])
    if (compilerExit !== 0) throw new Error(`Could not compile the sync shim: ${compilerError}`)
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", fileIoBenchmark],
      cwd: root,
      env: {
        HOME: root,
        LD_PRELOAD: shimPath,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TOURI_BENCH_DIR: root,
        TOURI_SYNC_SHIM: shimPath,
        TOURI_FILES: new URL("../../src/kernel/async-files.ts", import.meta.url).href,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    })

    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`File I/O benchmark failed: ${errors}`)
    const measured = JSON.parse(output.trim()) as {
      requestMs: number
      timerMs: number
      pending: number
      syncCalls: number
      complete: boolean
    }
    console.info(`file-sync-benchmark ${JSON.stringify(measured)}`)

    expect(measured.pending).toBe(200)
    expect(measured.requestMs).toBeLessThan(750)
    expect(measured.timerMs).toBeLessThan(50)
    expect(measured.syncCalls).toBeGreaterThanOrEqual(2)
    // One batched append syncs five descriptors; the settings replacement syncs three.
    expect(measured.syncCalls).toBeLessThanOrEqual(8)
    expect(measured.complete).toBe(true)
  },
  15_000,
)
