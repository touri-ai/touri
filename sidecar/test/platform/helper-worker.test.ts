import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeSmokeDirectory } from "../../../scripts/smoke-cleanup"
import { buildChildEnv } from "../../src/kernel/shell-env"
import { runHelperBlocking, stopHelperWorker } from "../../src/platform/helper-worker"

afterAll(stopHelperWorker)
const env = buildChildEnv()
const echo = [process.execPath, "-e", "process.stdout.write(await Bun.stdin.text())"]

test("native file replies preserve bytes without advancing the HTTP event loop", async () => {
  let active = false
  let reentered = false
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      reentered ||= active
      active = true
      try {
        const result = runHelperBlocking({ command: echo, input: "synthetic-ç", env })
        expect(result.exitCode).toBe(0)
        return new Response(result.stdout)
      } finally {
        active = false
      }
    },
  })
  try {
    const replies = await Promise.all(Array.from({ length: 4 }, async () => (await fetch(server.url)).text()))
    expect(replies).toEqual(Array(4).fill("synthetic-ç"))
    expect(reentered).toBe(false)
  } finally {
    server.stop(true)
  }
}, 30_000)

test("native helper replies have a bounded size", () => {
  expect(() => runHelperBlocking({ command: echo, input: "x".repeat(4096), env, maxResponseBytes: 64 })).toThrow()
}, 30_000)

test("native helper timeout cancels its own child before a late write", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-native-worker-"))
  const marker = join(root, "late")
  try {
    expect(() =>
      runHelperBlocking({
        command: [process.execPath, "-e", `await Bun.sleep(1000); await Bun.write(${JSON.stringify(marker)}, "late")`],
        env,
        timeoutMs: 100,
      }),
    ).toThrow()
    await Bun.sleep(1200)
    expect(existsSync(marker)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("the compiled binary retains the helper worker without a separate script", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-native-compiled-"))
  try {
    const entry = join(root, "entry.ts")
    const binary = join(root, process.platform === "win32" ? "fixture.exe" : "fixture")
    writeFileSync(
      entry,
      `import {runHelperBlocking,stopHelperWorker} from ${JSON.stringify(join(import.meta.dir, "../../src/platform/helper-worker.ts"))};
import {buildChildEnv} from ${JSON.stringify(join(import.meta.dir, "../../src/kernel/shell-env.ts"))};
if(process.argv.includes("--child")){process.stdout.write(await Bun.stdin.text());process.exit(0);}
const result=runHelperBlocking({command:[process.execPath,"--child"],input:"compiled-worker-ok",env:buildChildEnv()});
stopHelperWorker();if(result.exitCode!==0||result.stdout!=="compiled-worker-ok")process.exit(1);console.log(result.stdout);`,
    )
    // Bun stages the executable in cwd; keep its final rename on the fixture filesystem.
    const build = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        entry,
        "--compile",
        "--outfile",
        binary,
        ...(process.platform === "linux" && process.arch === "x64" ? ["--target=bun-linux-x64-baseline"] : []),
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    })
    const [buildOutput, buildErrors, buildCode] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ])
    expect({ code: buildCode, errors: buildCode === 0 ? "" : `${buildOutput}\n${buildErrors}` }).toEqual({
      code: 0,
      errors: "",
    })
    chmodSync(binary, 0o700)
    const child = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe", env })
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, errors, output: output.trim() }).toEqual({ code: 0, errors: "", output: "compiled-worker-ok" })
  } finally {
    await removeSmokeDirectory(root)
  }
}, 60_000)
