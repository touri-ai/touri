import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRunFailure } from "@touri/contracts/run-failure"
import { createKernel } from "../../src/kernel"
import { buildChildEnv } from "../../src/kernel/shell-env"
import { listLiveShims } from "../../src/mcp/shim-registry"
import { parseMcpShimStage } from "../../src/mcp/startup-stage"
import { isMcpStartupError, mcpStartupError } from "../../src/runtime/mcp-startup"
import { trackProviderProcess } from "../../src/runtime/provider-processes"

const providerFake = join(import.meta.dir, "..", "fakes", "fake-provider-with-shim.ts")
const mainEntry = join(import.meta.dir, "..", "..", "src", "main.ts")
const INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const state = Bun.spawnSync({ cmd: ["/bin/ps", "-o", "stat=", "-p", String(pid)], stdout: "pipe" }).stdout.toString()
  return state.trim() !== "" && !state.trim().startsWith("Z")
}

const waitFor = async (condition: () => boolean, ms = 8_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(50)
  }
  return condition()
}

type Fixture = { root: string; sock: string; sockets: Array<Socket>; server: Server }

const fixture = async ({ answer, threads }: { answer: boolean; threads: Array<string> }): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "touri-shim-startup-"))
  mkdirSync(join(root, "run", "mcp-tokens"), { recursive: true, mode: 0o700 })
  for (const thread of threads) writeFileSync(join(root, "run", "mcp-tokens", thread), "b".repeat(64), { mode: 0o600 })
  const sock = join(root, "s.sock")
  const sockets: Array<Socket> = []
  const server = createServer((socket) => {
    sockets.push(socket)
    socket.on("error", () => undefined)
    if (!answer) {
      socket.once("data", () => socket.destroy())
      return
    }
    socket.on("data", (chunk) => {
      if (String(chunk).includes('"initialize"')) socket.write('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, sock, sockets, server }
}

const providerEnv = ({ root, sock, leakedParent }: { root: string; sock: string; leakedParent: boolean }) => ({
  ...(process.env as Record<string, string>),
  TOURI_APP_DATA: root,
  TOURI_RUN_DIR: join(root, "run"),
  TOURI_MCP_SOCK: sock,
  ...(leakedParent ? { TOURI_PARENT_PID: String(process.pid) } : {}),
})

type ShimRun = { child: ChildProcess; replied: Promise<boolean>; stderr: () => string }

const startShimThroughShell = ({ env, thread }: { env: Record<string, string>; thread: string }): ShimRun => {
  const child = spawn("sh", ["-c", `bun run '${mainEntry}' mcp-stdio --thread ${thread}; true`], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  cleanups.push(() => {
    child.stdin?.destroy()
    child.kill("SIGKILL")
  })
  const state = { text: "" }
  child.stderr?.on("data", (chunk) => {
    state.text += String(chunk)
  })
  const replied = new Promise<boolean>((resolve) => {
    child.stdout?.once("data", () => resolve(true))
    child.once("exit", () => resolve(false))
  })
  setTimeout(() => child.stdin?.write(INITIALIZE), 300)
  return { child, replied, stderr: () => state.text }
}

test("provider env never carries the sidecar's parent pid into an MCP shim", () => {
  const env = buildChildEnv({
    base: { PATH: "/usr/bin", TOURI_PARENT_PID: "123" },
    overrides: { TOURI_PARENT_PID: "456", TOURI_RUN_DIR: "/run" },
  })
  expect(env.TOURI_PARENT_PID).toBeUndefined()
  expect(env.TOURI_RUN_DIR).toBe("/run")
})

test("concurrent turns behind an intermediate shell all load tools even when the parent pid leaked into env", async () => {
  const threads = ["thread-a", "thread-b", "thread-c", "thread-d", "thread-e", "thread-f"]
  const { root, sock } = await fixture({ answer: true, threads })
  const runs = threads.map((thread) =>
    startShimThroughShell({ env: providerEnv({ root, sock, leakedParent: true }), thread }),
  )
  expect(await Promise.all(runs.map((run) => run.replied))).toEqual(threads.map(() => true))
  await Bun.sleep(800)
  for (const run of runs) expect(run.child.exitCode).toBeNull()
  expect((await listLiveShims(join(root, "run"))).length).toBe(threads.length)
})

test("a shim stopped before answering names the stage on stderr", async () => {
  const { root, sock } = await fixture({ answer: false, threads: ["thread-a"] })
  const run = startShimThroughShell({ env: providerEnv({ root, sock, leakedParent: false }), thread: "thread-a" })
  expect(await run.replied).toBe(false)
  await waitFor(() => run.stderr().includes("startup failed"))
  expect(run.stderr()).toContain("touri MCP startup failed: closed_before_initialize")
})

test("a shim whose provider closes stdin before any reply names the stdin stage", async () => {
  const { root, sock, sockets } = await fixture({ answer: true, threads: ["thread-a"] })
  const mute = createServer((socket) => sockets.push(socket))
  const muteSock = join(root, "mute.sock")
  await new Promise<void>((resolve) => mute.listen(muteSock, resolve))
  cleanups.push(() => mute.close())
  const run = startShimThroughShell({
    env: { ...providerEnv({ root, sock, leakedParent: false }), TOURI_MCP_SOCK: muteSock },
    thread: "thread-a",
  })
  run.child.stdin?.end()
  expect(await waitFor(() => run.stderr().includes("touri MCP startup failed: stdin_closed"))).toBe(true)
})

test("ending one provider turn does not reap the shim of a turn that is starting", async () => {
  const { root, sock, sockets } = await fixture({ answer: true, threads: ["thread-orphan"] })
  const runtime = createKernel({ appData: root })
  const pidA = join(root, "a.pid")
  const pidB = join(root, "b.pid")
  const spawnProvider = async (pidFile: string) => {
    const spawned = runtime.kernel.spawnTree({
      cmd: "bun",
      args: ["run", providerFake],
      cwd: root,
      env: { ...providerEnv({ root, sock, leakedParent: false }), FAKE_SHIM_PID_FILE: pidFile },
    })
    if (!spawned.success) throw new Error(spawned.error)
    await trackProviderProcess(runtime.kernel, spawned)
    return spawned
  }
  const first = await spawnProvider(pidA)
  const second = await spawnProvider(pidB)
  const pidOf = async (path: string): Promise<number> => {
    await waitFor(() => {
      try {
        return readFileSync(path, "utf8").length > 0
      } catch {
        return false
      }
    })
    const pid = Number(readFileSync(path, "utf8"))
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL")
    })
    return pid
  }
  const shimA = await pidOf(pidA)
  const shimB = await pidOf(pidB)
  expect(await waitFor(() => sockets.length === 2)).toBe(true)
  first.kill("SIGTERM")
  await first.exited
  expect(await waitFor(() => !alive(shimA))).toBe(true)
  await Bun.sleep(2_500)
  expect(alive(shimB)).toBe(true)
  expect((await listLiveShims(join(root, "run"))).map((shim) => shim.record.pid)).toContain(shimB)
  second.kill("SIGTERM")
  await second.exited
  runtime.stop()
})

test("startup stages are parsed from shim lines and CLI timeouts", () => {
  expect(parseMcpShimStage("touri MCP startup failed: parent_gone")).toBe("parent_gone")
  expect(parseMcpShimStage("touri MCP startup failed: bridge_closed (bridge closed before the initialize)")).toBe(
    "bridge_closed",
  )
  expect(parseMcpShimStage("MCP client for `touri` timed out after 10 seconds")).toBe("handshake_timeout")
  expect(parseMcpShimStage("MCP client for `touri` failed")).toBe("unknown")
})

test("the E3003 run failure shows the specific stage", () => {
  const error = mcpStartupError({ diagnostic: "touri MCP startup failed: closed_before_initialize" })
  expect(isMcpStartupError(error)).toBe(true)
  const failure = safeRunFailure("cli_protocol", error)
  expect(failure.detail).toContain("As ferramentas do touri não carregaram nesta máquina")
  expect(failure.detail).toContain("recusou ou fechou a conexão")
  expect(failure.action?.kind).toBe("doctor")
})
