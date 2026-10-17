import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { orphanShimCheck } from "../../src/doctor/mcp"
import { createKernel } from "../../src/kernel"
import { listLiveShims, reapOrphanShims } from "../../src/mcp/shim-registry"
import { trackProviderProcess } from "../../src/runtime/provider-processes"

const providerFake = join(import.meta.dir, "..", "fakes", "fake-provider-with-shim.ts")
const holderFake = join(import.meta.dir, "..", "fakes", "fake-shim-holder.ts")
const mainEntry = join(import.meta.dir, "..", "..", "src", "main.ts")
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

const waitFor = async (condition: () => boolean | Promise<boolean>, ms = 8_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await Bun.sleep(50)
  }
  return condition()
}

const fixture = async (): Promise<{ root: string; sock: string; sockets: Array<Socket>; server: Server }> => {
  const root = mkdtempSync(join(tmpdir(), "touri-orphan-shim-"))
  mkdirSync(join(root, "run", "mcp-tokens"), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, "run", "mcp-tokens", "thread-orphan"), "a".repeat(64), { mode: 0o600 })
  const sock = join(root, "s.sock")
  const sockets: Array<Socket> = []
  const server = createServer((socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, sock, sockets, server }
}

const shimEnv = (root: string, sock: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  TOURI_APP_DATA: root,
  TOURI_MCP_SOCK: sock,
})

const readPid = async (path: string): Promise<number> => {
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

test("cancelling a provider turn terminates the MCP shim it spawned", async () => {
  const { root, sock, sockets } = await fixture()
  const runtime = createKernel({ appData: root })
  const pidFile = join(root, "shim.pid")
  const spawned = runtime.kernel.spawnTree({
    cmd: "bun",
    args: ["run", providerFake],
    cwd: root,
    env: { ...shimEnv(root, sock), FAKE_SHIM_PID_FILE: pidFile },
  })
  if (!spawned.success) throw new Error(spawned.error)
  await trackProviderProcess(runtime.kernel, spawned)
  const shimPid = await readPid(pidFile)
  expect(await waitFor(() => sockets.length === 1)).toBe(true)
  expect(alive(shimPid)).toBe(true)
  spawned.kill("SIGTERM")
  await spawned.exited
  expect(await waitFor(() => !alive(shimPid))).toBe(true)
  runtime.stop()
})

test("a provider leader that exits on its own does not leave its shim behind", async () => {
  const { root, sock, sockets } = await fixture()
  const runtime = createKernel({ appData: root })
  const pidFile = join(root, "shim.pid")
  const spawned = runtime.kernel.spawnTree({
    cmd: "bun",
    args: ["run", providerFake],
    cwd: root,
    env: {
      ...shimEnv(root, sock),
      FAKE_SHIM_PID_FILE: pidFile,
      FAKE_PROVIDER_EXITS: "1",
      FAKE_PROVIDER_EXIT_FILE: join(root, "leader.exit"),
      FAKE_SHIM_DETACHED: "0",
    },
  })
  if (!spawned.success) throw new Error(spawned.error)
  await trackProviderProcess(runtime.kernel, spawned)
  const shimPid = await readPid(pidFile)
  expect(await waitFor(() => sockets.length === 1)).toBe(true)
  writeFileSync(join(root, "leader.exit"), "ready")
  await spawned.exited
  expect(await waitFor(() => !alive(shimPid))).toBe(true)
  runtime.stop()
})

test("a shim exits by itself when its parent dies, even in another process group", async () => {
  const { root, sock, sockets } = await fixture()
  const pidFile = join(root, "shim.pid")
  const parent = Bun.spawn({
    cmd: ["bun", "run", providerFake],
    env: { ...shimEnv(root, sock), FAKE_SHIM_PID_FILE: pidFile, FAKE_SHIM_DETACHED: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  const shimPid = await readPid(pidFile)
  expect(await waitFor(() => sockets.length === 1)).toBe(true)
  parent.kill("SIGKILL")
  expect(await waitFor(() => !alive(shimPid))).toBe(true)
})

test("a shim exits when the sidecar socket closes", async () => {
  const { root, sock, sockets } = await fixture()
  const shim = Bun.spawn({
    cmd: ["bun", "run", mainEntry, "mcp-stdio", "--thread", "thread-orphan"],
    env: shimEnv(root, sock),
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  cleanups.push(() => shim.kill("SIGKILL"))
  expect(await waitFor(() => sockets.length === 1)).toBe(true)
  for (const socket of sockets) socket.destroy()
  expect(await waitFor(() => !alive(shim.pid))).toBe(true)
})

test("a shim exits when its stdin reaches EOF", async () => {
  const { root, sock, sockets } = await fixture()
  const shim = Bun.spawn({
    cmd: ["bun", "run", mainEntry, "mcp-stdio", "--thread", "thread-orphan"],
    env: shimEnv(root, sock),
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  cleanups.push(() => shim.kill("SIGKILL"))
  expect(await waitFor(() => sockets.length === 1)).toBe(true)
  shim.stdin.end()
  expect(await waitFor(() => !alive(shim.pid))).toBe(true)
})

test("the startup sweep and Doctor only touch shims recorded by this install", async () => {
  const { root } = await fixture()
  const runDir = join(root, "run")
  const holder = (): number => {
    const parent = Bun.spawnSync({
      cmd: [
        "/bin/sh",
        "-c",
        `TOURI_RUN_DIR='${runDir}' bun run '${holderFake}' mcp-stdio >/dev/null 2>&1 </dev/null & echo $!`,
      ],
      stdout: "pipe",
    })
    return Number(parent.stdout.toString().trim())
  }
  const orphan = holder()
  const bystander = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore" })
  cleanups.push(() => {
    bystander.kill("SIGKILL")
    if (alive(orphan)) process.kill(orphan, "SIGKILL")
  })
  expect(await waitFor(async () => (await listLiveShims(runDir)).some((shim) => shim.record.pid === orphan))).toBe(true)
  expect(await waitFor(async () => (await orphanShimCheck(runDir)).status === "warn")).toBe(true)
  expect((await orphanShimCheck(runDir)).detail).toContain(String(orphan))
  expect(await reapOrphanShims(runDir)).toEqual([orphan])
  expect(await waitFor(() => !alive(orphan))).toBe(true)
  expect(alive(bystander.pid)).toBe(true)
  expect((await orphanShimCheck(runDir)).status).toBe("pass")
})
