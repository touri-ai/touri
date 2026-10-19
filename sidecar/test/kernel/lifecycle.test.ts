import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRuntimeLock } from "../../src/kernel/lifecycle"
import { createAppPaths } from "../../src/kernel/paths"

const main = join(import.meta.dir, "../../src/main.ts")
const parentScript = join(import.meta.dir, "../fakes/lifecycle-parent.ts")
const waitFor = async (predicate: () => boolean, timeout = 10_000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started >= timeout) throw new Error("Timed out waiting for disposable runtime")
    await Bun.sleep(25)
  }
}
const alive = (pid: number) => {
  const result = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)])
  return result.exitCode === 0 && !/^[ZX]/.test(result.stdout.toString().trim())
}
const lines = async (stream: ReadableStream<Uint8Array>, count: number) => {
  const reader = stream.getReader()
  let text = ""
  try {
    while (text.split("\n").length <= count) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Fixture exited before handshake: ${text}`)
      text += new TextDecoder().decode(chunk.value)
    }
    return text
      .split("\n")
      .slice(0, count)
      .map((line) => JSON.parse(line))
  } finally {
    reader.releaseLock()
  }
}
const spawn = (root: string, parent = false) =>
  Bun.spawn({
    cmd: [process.execPath, "run", parent ? parentScript : main, ...(parent ? [] : ["serve"])],
    env: { ...process.env, TOURI_APP_DATA: root, TOURI_HEADLESS: "1", TOURI_PARENT_PID: String(process.pid) },
    stdout: "pipe",
    stderr: "pipe",
  })

test("a shell lost before initialization cannot start a scheduler", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-parent-before-start-"))
  const child = Bun.spawn({
    cmd: [process.execPath, "run", main, "serve"],
    env: { ...process.env, TOURI_APP_DATA: root, TOURI_HEADLESS: "1", TOURI_PARENT_PID: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("")
  } finally {
    child.kill("SIGKILL")
    await child.exited
    rmSync(root, { recursive: true, force: true })
  }
})

test("a killed shell leaves no orphan sidecar, and a new shell acquires the same data directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-parent-death-"))
  const parent = spawn(root, true)
  let pid: number | undefined
  let replacement: ReturnType<typeof spawn> | undefined
  try {
    const [child, handshake] = await lines(parent.stdout, 2)
    pid = child.childPid
    expect(handshake.pid).toBe(pid)
    parent.kill("SIGKILL")
    await parent.exited
    await waitFor(() => !alive(pid ?? 0))
    replacement = spawn(root)
    expect((await lines(replacement.stdout, 1))[0].type).toBe("touri-sidecar-ready")
  } finally {
    parent.kill("SIGKILL")
    if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    replacement?.kill("SIGTERM")
    await replacement?.exited
    await parent.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("the lock rejects a second live runtime and takes over a suspended orphan before starting modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-runtime-takeover-"))
  const parent = spawn(root, true)
  let pid: number | undefined
  let contender: ReturnType<typeof spawn> | undefined
  let replacement: ReturnType<typeof spawn> | undefined
  try {
    const [child, handshake] = await lines(parent.stdout, 2)
    pid = child.childPid
    if (!pid) throw new Error("Missing disposable PID")
    contender = spawn(root)
    expect(await contender.exited).not.toBe(0)
    expect(await new Response(contender.stderr).text()).toContain("Já existe um runtime ativo")
    await waitFor(() => readFileSync(join(root, "logs/sidecar.log"), "utf8").includes("./runtime/index.ts"))
    expect(
      readFileSync(join(root, "logs/sidecar.log"), "utf8").match(/initialized module \.\/runtime\/index.ts/g),
    ).toHaveLength(1)
    expect(alive(pid)).toBe(true)
    expect(JSON.parse(readFileSync(join(root, "run/runtime.lock"), "utf8")).pid).toBe(pid)
    process.kill(pid, "SIGSTOP")
    parent.kill("SIGKILL")
    await parent.exited
    replacement = spawn(root)
    const next = (await lines(replacement.stdout, 1))[0]
    expect(next.pid).not.toBe(handshake.pid)
    expect(alive(pid)).toBe(false)
    expect(JSON.parse(readFileSync(join(root, "run/runtime.lock"), "utf8")).pid).toBe(next.pid)
  } finally {
    parent.kill("SIGKILL")
    if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    contender?.kill("SIGKILL")
    replacement?.kill("SIGTERM")
    await replacement?.exited
    await parent.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("stale lock metadata with a reused PID does not signal that process", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-lock-pid-reuse-"))
  const paths = createAppPaths({ appData: root })
  const holder = await acquireRuntimeLock(paths)
  try {
    writeFileSync(
      join(paths.runDir, "runtime.lock"),
      JSON.stringify({ pid: process.pid, startTime: "different birth" }),
    )
    await expect(acquireRuntimeLock(paths, { timeoutMs: 100 })).rejects.toThrow("não liberou")
    process.kill(process.pid, 0)
  } finally {
    holder.release()
    const next = await acquireRuntimeLock(paths)
    next.release()
    rmSync(root, { recursive: true, force: true })
  }
})
