import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, Thread } from "@touri/contracts"
import { httpGateway } from "../../src/cloud/gateway"
import { createKernel } from "../../src/kernel"
import { createMcpSocket } from "../../src/mcp/socket"
import { ownTouriProcesses } from "../../src/reports/bundle"
import { workingDirectory } from "../../src/runtime/session"
import { capabilityListener, privateSocket } from "../../src/vm/local-transport"
import { createHarness } from "../projects/harness"

// R13: another macOS account on the same Mac must not read or drive anything.
// Every file touri creates is owner-only and every loopback listener rejects a
// caller that holds no per-session credential.

const mode = (path: string): number => statSync(path).mode & 0o777

const externalAddresses = (): Array<string> =>
  Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry?.address ?? "")
    .filter(Boolean)

const withEnv = async (values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  try {
    await run()
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
}

test("a packaged sidecar without TOURI_UI_TOKEN never accepts the public development token", async () => {
  await withEnv({ TOURI_UI_TOKEN: undefined, NODE_ENV: "production" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-r13-token-"))
    const runtime = createKernel({ appData: root })
    try {
      const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1/health`
      const response = await fetch(url, {
        headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
      })
      expect(response.status).toBe(401)
    } finally {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("an empty TOURI_UI_TOKEN does not turn an empty bearer into a credential", async () => {
  await withEnv({ TOURI_UI_TOKEN: "", NODE_ENV: "production" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-r13-empty-"))
    const runtime = createKernel({ appData: root })
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/health`, {
        headers: { Authorization: "Bearer ", Origin: "tauri://localhost" },
      })
      expect(response.status).toBe(401)
    } finally {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("the kernel listener is loopback-only and rejects every unauthenticated caller", async () => {
  await withEnv({ TOURI_UI_TOKEN: "r13-secret-token" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-r13-kernel-"))
    const runtime = createKernel({ appData: root })
    try {
      const base = `http://127.0.0.1:${runtime.handshake.port}`
      for (const path of ["/", "/api/v1/health", "/api/v1/bots", "/api/v1/threads", "/api/v1/settings", "/health"]) {
        for (const headers of [{}, { Origin: "tauri://localhost" }, { "x-touri-client": "other-user" }]) {
          const response = await fetch(`${base}${path}`, { headers })
          expect(response.status).toBe(401)
        }
      }
      const socket = await fetch(`${base}/api/v1/events`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Origin: "tauri://localhost" },
      })
      expect(socket.status).toBe(401)
      for (const address of externalAddresses()) {
        const reached = await new Promise<boolean>((resolve) => {
          const probe = createConnection({ host: address, port: runtime.handshake.port })
          probe.setTimeout(1000, () => {
            probe.destroy()
            resolve(false)
          })
          probe.once("connect", () => {
            probe.destroy()
            resolve(true)
          })
          probe.once("error", () => resolve(false))
        })
        expect({ address, reached }).toEqual({ address, reached: false })
      }
    } finally {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("preview, CDP and cloud gateway listeners deny callers without the capability", async () => {
  const preview = await capabilityListener((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecret"))
  const cloud = httpGateway(
    {
      endpoint: (path: string) => `https://cloud.invalid${path}`,
      access: async () => "cloud-token",
      socket: async () => {
        throw new Error("unreachable")
      },
    } as unknown as Parameters<typeof httpGateway>[0],
    "https://cloud.invalid/machines/m1/cdp",
    { generation: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  )
  try {
    for (const listener of [preview, cloud]) {
      const base = new URL(listener.url)
      expect(base.hostname).toBe("127.0.0.1")
      for (const path of ["/", "/json/version", "/touri/0000/", `${base.pathname.slice(0, -4)}0000/`]) {
        const response = await fetch(`http://127.0.0.1:${listener.hostPort}${path}`, { redirect: "manual" })
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain("secret")
      }
    }
  } finally {
    preview.close()
    cloud.close()
  }
})

test("app data, database, logs, run dir and MCP socket are owner-only", async () => {
  const parent = mkdtempSync(join(tmpdir(), "touri-r13-modes-"))
  const root = join(parent, "touri")
  const previousUmask = process.umask(0o022)
  const runtime = createKernel({ appData: root })
  try {
    runtime.kernel.log({ level: "info", module: "r13", msg: "mode probe" })
    const paths = runtime.kernel.paths
    for (const directory of [
      paths.appData,
      paths.runDir,
      paths.botsDir,
      paths.attachmentsDir,
      paths.projectsDir,
      paths.browserDir,
      paths.sessionsDir,
      paths.importsDir,
      paths.logsDir,
      join(paths.runDir, "mcp-tokens"),
    ])
      expect({ directory, mode: mode(directory) }).toEqual({ directory, mode: 0o700 })
    for (const file of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`])
      expect({ file, mode: mode(file) }).toEqual({ file, mode: 0o600 })
    const mcp = createMcpSocket({ kernel: runtime.kernel, registrations: new Map() })
    await mcp.listen()
    try {
      expect(mode(mcp.socketPath)).toBe(0o600)
    } finally {
      await mcp.close()
    }
    const channel = await privateSocket()
    try {
      expect(mode(join(channel.path, ".."))).toBe(0o700)
    } finally {
      await channel.remove()
    }
  } finally {
    process.umask(previousUmask)
    runtime.stop()
    rmSync(parent, { recursive: true, force: true })
  }
})

test("a bot workspace touri creates under the home folder is owner-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "touri-r13-home-"))
  const previousUmask = process.umask(0o022)
  try {
    const cwd = join(home, "touri", "workspaces", "onb")
    const result = await workingDirectory({
      kernel: {} as Kernel,
      bot: { cwd, homeDir: join(home, "bot-home"), projectId: null } as Bot,
      thread: { cwdOverride: null } as Thread,
    })
    expect(result.cwd).toBe(cwd)
    for (const directory of [join(home, "touri"), join(home, "touri", "workspaces"), cwd])
      expect({ directory, mode: mode(directory) }).toEqual({ directory, mode: 0o700 })
  } finally {
    process.umask(previousUmask)
    rmSync(home, { recursive: true, force: true })
  }
})

test("an existing user-chosen workspace keeps the permissions the user gave it", async () => {
  const home = mkdtempSync(join(tmpdir(), "touri-r13-own-"))
  try {
    const cwd = join(home, "shared-project")
    mkdirSync(cwd, { mode: 0o755 })
    await workingDirectory({
      kernel: {} as Kernel,
      bot: { cwd, homeDir: join(home, "bot-home"), projectId: null } as Bot,
      thread: { cwdOverride: null } as Thread,
    })
    expect(mode(cwd)).toBe(0o755)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a repository cloned by touri is owner-only even when the chosen parent is shared", async () => {
  const harness = await createHarness()
  const previousUmask = process.umask(0o022)
  try {
    const source = join(harness.root, "source")
    const bare = join(harness.root, "source.git")
    const parent = join(harness.root, "shared-parent")
    mkdirSync(source)
    mkdirSync(parent, { mode: 0o755 })
    writeFileSync(join(source, "SECRET.md"), "private source")
    const run = (args: Array<string>, cwd: string): void => {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
    }
    run(["init", "-q"], source)
    run(["config", "user.email", "test@example.com"], source)
    run(["config", "user.name", "Test"], source)
    run(["add", "."], source)
    run(["commit", "-qm", "fixture"], source)
    run(["clone", "--bare", source, bare], harness.root)
    const response = await harness.request("/projects", {
      method: "POST",
      body: JSON.stringify({ gitUrl: bare, parentDir: parent, name: "private-clone" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(response.status).toBe(201)
    const project = ((await response.json()) as { project: { path: string } }).project
    expect(mode(project.path)).toBe(0o700)
    expect(mode(parent)).toBe(0o755)
  } finally {
    process.umask(previousUmask)
    await harness.close()
  }
}, 30_000)

test("a failed clone leaves no destination folder behind", async () => {
  const harness = await createHarness()
  try {
    const parent = join(harness.root, "clones")
    mkdirSync(parent)
    const response = await harness.request("/projects", {
      method: "POST",
      body: JSON.stringify({ gitUrl: join(harness.root, "missing.git"), parentDir: parent, name: "broken" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(response.status).not.toBe(201)
    expect(() => statSync(join(parent, "broken"))).toThrow()
  } finally {
    await harness.close()
  }
}, 30_000)

test("a bug report's process list never includes another macOS account's touri", () => {
  const output = [
    "  100     1   501  20480 /Applications/touri.app/Contents/MacOS/touri",
    "  101   100   501  10240 /Applications/touri.app/Contents/MacOS/touri-sidecar",
    "  102   101   501   4096 node",
    "  200     1   502  30720 /Applications/touri.app/Contents/MacOS/touri",
    "  201   200   502  10240 /Applications/touri.app/Contents/MacOS/touri-sidecar",
    "  202   201   502   4096 claude",
    "  300   101   502   4096 node",
  ].join("\n")
  const processes = ownTouriProcesses({ output, uid: 501, rootPid: 101 })
  expect(processes.map((row) => row.pid).sort()).toEqual([100, 101, 102])
  expect(processes[0]).toEqual({
    pid: 100,
    parentPid: 1,
    rssBytes: 20480 * 1024,
    executable: "/Applications/touri.app/Contents/MacOS/touri",
  })
})
