import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { canonicalPath, excludedBotFolders, folderGuestPath, parseBotFolders } from "../../src/kernel/bot-folders"
import * as folderCapability from "../../src/kernel/folder-capability"
import { createAppPaths, resolveMcpSocketPath } from "../../src/kernel/paths"
import { claudeSettings } from "../../src/runtime/claude/settings"
import {
  localFolderProfile,
  spawnFolderProvider,
  turnFolders,
  writableTurnFolders,
} from "../../src/runtime/folder-access"
import { composeDeveloperInstructions } from "../../src/runtime/instructions"
import { openCodeConfig } from "../../src/runtime/opencode/config"
import { sessionFingerprint } from "../../src/runtime/session"
import { init as initStore } from "../../src/store"
import { botFolderMounts } from "../../src/vm/folder-mounts"
import { createFixtureStore } from "../mcp/store-fixture"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const fixture = async () => {
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "touri-folders-")))
  const home = join(root, "home")
  const ro = join(home, "reference")
  const rw = join(home, "work")
  for (const path of [ro, rw, join(home, ".ssh"), join(home, "Library/Keychains")]) mkdirSync(path, { recursive: true })
  const runtime = createKernel({ appData: join(home, "touri-data") })
  await initStore(runtime.kernel)
  cleanups.push(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const request = (path: string, body: unknown = {}, method = "PATCH") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "Content-Type": "application/json",
        Origin: "tauri://localhost",
      },
      body: JSON.stringify(body),
    })
  const response = await request("/bots", { name: "Folders", provider: "claude" }, "POST")
  const { bot } = (await response.json()) as { bot: Bot }
  const thread = runtime.kernel.services.use("store.api")?.getThread({ threadId: bot.mainThreadId ?? "" })
  if (!thread) throw new Error("Missing thread")
  const args: StartTurnArgs = {
    bot,
    thread,
    fingerprint: sessionFingerprint({ bot, cwd: bot.homeDir, mcpCommand: "fake", mcpArgs: [] }).fingerprint,
    session: null,
    input: [],
    developerInstructions: "",
    handoffPacket: null,
    mcp: { command: "fake", args: [], env: {} },
    env: { HOME: home },
    onEvent: () => {},
    signal: new AbortController().signal,
  }
  return { root, home, ro, rw, runtime, request, bot, args }
}

test("folder grants default off, persist per bot, reject malformed input and only change via the authenticated API", async () => {
  const f = await fixture()
  expect(f.bot.folders).toEqual([])
  expect(f.bot.anyFolderAccess).toBe(false)
  const folders: NonNullable<Bot["folders"]> = [
    { path: f.ro, access: "read-only" },
    { path: f.rw, access: "read-write" },
  ]
  const anyFolderAccess = process.platform !== "linux"
  const response = await f.request(`/bots/${f.bot.id}`, { folders, anyFolderAccess })
  expect(response.status).toBe(200)
  expect(((await response.json()) as { bot: Bot }).bot).toMatchObject({ folders, anyFolderAccess })
  if (process.platform === "linux") {
    const broad = await f.request(`/bots/${f.bot.id}`, { anyFolderAccess: true })
    expect(broad.status).toBe(400)
    expect(await broad.json()).toMatchObject({
      errorCode: "FOLDER_SELECTION_REQUIRED",
      error: folderCapability.specificFoldersRequired,
    })
    expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: f.bot.id })?.anyFolderAccess).toBe(false)
    const root = await f.request(`/bots/${f.bot.id}`, { folders: [{ path: "/", access: "read-only" }] })
    expect(root.status).toBe(400)
    expect(await root.json()).toMatchObject({ error: folderCapability.specificFoldersRequired })
    expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: f.bot.id })?.folders).toEqual(folders)
    for (const path of ["/proc", "/sys", "/dev", "/dev/shm"]) {
      const protectedFolder = await f.request(`/bots/${f.bot.id}`, { folders: [{ path, access: "read-only" }] })
      expect(protectedFolder.status).toBe(400)
      expect(await protectedFolder.json()).toMatchObject({ error: "Esta pasta é protegida. Escolha outra pasta." })
      expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: f.bot.id })?.folders).toEqual(folders)
    }
  }
  expect((await f.request(`/bots/${f.bot.id}`, { folders: [{ path: f.ro, access: "full" }] })).status).toBe(400)
  expect((await f.request(`/bots/${f.bot.id}`, { anyFolderAccess: "yes" })).status).toBe(400)
  const other = await f.request("/bots", { name: "Other", provider: "codex" }, "POST")
  expect(((await other.json()) as { bot: Bot }).bot).toMatchObject({ folders: [], anyFolderAccess: false })
  const unauthenticated = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/bots/${f.bot.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anyFolderAccess: false }),
  })
  expect(unauthenticated.status).toBe(401)
})

test("unavailable confinement rejects API and setup grants without persisting and still permits removal", async () => {
  const f = await fixture()
  const available = spyOn(folderCapability, "hostFolderAccessAvailable").mockReturnValue(false)
  try {
    const folder = { path: f.ro, access: "read-only" as const }
    const response = await f.request(`/bots/${f.bot.id}`, { folders: [folder] })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("Nenhuma permissão foi adicionada")
    expect((await f.request(`/bots/${f.bot.id}`, { anyFolderAccess: true })).status).toBe(400)
    expect((await f.request("/bots", { name: "New", provider: "codex", folders: [folder] }, "POST")).status).toBe(400)
    const configure = f.runtime.kernel.services.use("bots.configureAccess")
    expect(configure?.({ botId: f.bot.id, patch: { folders: [folder] } })).toMatchObject({ success: false })
    const store = f.runtime.kernel.services.use("store.api")
    expect(store?.getBot({ botId: f.bot.id })?.folders).toEqual([])
    expect((await f.request(`/bots/${f.bot.id}`, { folders: [], anyFolderAccess: false })).status).toBe(200)
  } finally {
    available.mockRestore()
  }
})

test("Linux provider spawning enforces RO and RW grants instead of failing the conversation", async () => {
  if (process.platform !== "linux" || !(await folderCapability.refreshHostFolderAccess())) return
  const f = await fixture()
  f.args.bot.folders = [
    { path: f.ro, access: "read-only" },
    { path: f.rw, access: "read-write" },
  ]
  writeFileSync(join(f.ro, "reference.txt"), "unchanged")
  const run = async (path: string) => {
    const child = spawnFolderProvider(f.runtime.kernel, f.args, {
      cmd: "/bin/sh",
      args: ["-c", 'printf saved > "$1"', "test", path],
      cwd: f.bot.homeDir,
      env: f.args.env,
    })
    expect(child.success).toBe(true)
    if (!child.success) throw new Error(child.error)
    const [exit] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return exit.code
  }
  expect(await run(join(f.ro, "reference.txt"))).not.toBe(0)
  expect(readFileSync(join(f.ro, "reference.txt"), "utf8")).toBe("unchanged")
  expect(await run(join(f.rw, "saved.txt"))).toBe(0)
  expect(readFileSync(join(f.rw, "saved.txt"), "utf8")).toBe("saved")
})

test("realpath grants reject escape symlinks, duplicates, conflicting overlaps and retargeted directories", async () => {
  const f = await fixture()
  expect(parseBotFolders([{ path: `${f.ro}/.`, access: "read-only" }])).toEqual([{ path: f.ro, access: "read-only" }])
  symlinkSync(f.rw, join(f.ro, "escape"))
  expect(() => parseBotFolders([{ path: f.ro, access: "read-only" }])).toThrow("fora")
  rmSync(join(f.ro, "escape"))
  symlinkSync(f.ro, join(f.ro, "internal"))
  expect(parseBotFolders([{ path: f.ro, access: "read-only" }])).toHaveLength(1)
  rmSync(join(f.ro, "internal"))
  symlinkSync(f.ro, join(f.home, "alias"))
  expect(() => parseBotFolders([{ path: join(f.home, "alias"), access: "read-only" }])).toThrow("original")
  expect(() =>
    parseBotFolders([
      { path: f.ro, access: "read-only" },
      { path: f.ro, access: "read-only" },
    ]),
  ).toThrow("já")
  mkdirSync(join(f.ro, "nested"))
  expect(() =>
    parseBotFolders([
      { path: f.ro, access: "read-only" },
      { path: join(f.ro, "nested"), access: "read-write" },
    ]),
  ).toThrow("sobrepostas")
  f.args.bot.folders = [{ path: f.ro, access: "read-only" }]
  rmSync(f.ro, { recursive: true })
  symlinkSync(f.rw, f.ro)
  expect(() => turnFolders(f.args)).toThrow()
})

test("mount plan preserves RO across home aliases, masks sensitive paths and permits only explicit exceptions", async () => {
  const f = await fixture()
  f.bot.anyFolderAccess = true
  f.bot.folders = [{ path: f.ro, access: "read-only" }]
  const mounts = botFolderMounts(f.runtime.kernel, f.bot, f.home)
  expect(mounts).toContainEqual({ type: "bind", source: f.home, target: "/host/home", readOnly: false })
  expect(mounts).toContainEqual({ type: "bind", source: f.ro, target: folderGuestPath(f.ro), readOnly: true })
  expect(mounts).toContainEqual({ type: "bind", source: f.ro, target: "/host/home/reference", readOnly: true })
  for (const target of [
    "/host/home/.ssh",
    "/host/home/Library/Keychains",
    "/host/home/Library/Application Support/Google/Chrome",
    "/host/home/touri-data",
  ])
    expect(mounts.some((mount) => mount.target === target && mount.readOnly && mount.source.endsWith("/empty"))).toBe(
      true,
    )
  f.bot.folders.push({ path: join(f.home, ".ssh"), access: "read-only" })
  const exception = botFolderMounts(f.runtime.kernel, f.bot, f.home)
  expect(exception.some((mount) => mount.target === "/host/home/.ssh" && mount.source.endsWith("/empty"))).toBe(false)
  expect(exception).toContainEqual({
    type: "bind",
    source: join(f.home, ".ssh"),
    target: "/host/home/.ssh",
    readOnly: true,
  })
  f.bot.access = "read-only"
  expect(botFolderMounts(f.runtime.kernel, f.bot, f.home).every((mount) => mount.readOnly)).toBe(true)
})

test("provider permissions and session identity follow grants and guest paths without widening access", async () => {
  const f = await fixture()
  f.bot.folders = [
    { path: f.ro, access: "read-only" },
    { path: f.rw, access: "read-write" },
  ]
  expect(writableTurnFolders(f.args)).toEqual([f.rw])
  const settings = await claudeSettings(f.args, { HOME: f.home })
  expect(settings.settings.permissions.deny).toContain(`Edit(/${f.ro}/**)`)
  expect(openCodeConfig(f.args).permission.external_directory).toMatchObject({
    [`${f.ro}/**`]: "allow",
    [`${f.rw}/**`]: "allow",
  })
  expect(openCodeConfig(f.args).permission.edit).toMatchObject({ [`${f.ro}/**`]: "deny" })
  const first = sessionFingerprint({ bot: f.bot, cwd: f.ro, mcpCommand: "fake", mcpArgs: [] }).hash
  f.bot.anyFolderAccess = true
  expect(writableTurnFolders(f.args)).toContain("/")
  expect(sessionFingerprint({ bot: f.bot, cwd: f.ro, mcpCommand: "fake", mcpArgs: [] }).hash).not.toBe(first)
  f.args.execution = {
    spawn: () => {
      throw new Error("Must not spawn")
    },
    writeFile: async () => {},
  }
  expect(turnFolders(f.args).map((folder) => folder.path)).toEqual([
    "/host/home",
    folderGuestPath(f.ro),
    folderGuestPath(f.rw),
  ])
  f.bot.access = "read-only"
  expect(writableTurnFolders(f.args)).toEqual([])
})

test("local profile denies sensitive trees including touri's API credential, even with full access", async () => {
  const f = await fixture()
  f.bot.access = "full"
  f.bot.anyFolderAccess = true
  f.bot.folders = [{ path: f.ro, access: "read-only" }]
  const profile = localFolderProfile(f.runtime.kernel, f.args, { HOME: f.home }, f.home)
  expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(f.ro)}))`)
  for (const path of excludedBotFolders(f.runtime.kernel.paths.appData, f.home))
    expect(profile).toContain(
      `(deny ${path === f.runtime.kernel.paths.appData ? "file-read*" : "file-read* file-write*"} (require-all (subpath ${JSON.stringify(path)})`,
    )
  expect(profile).not.toContain(`(require-not (subpath ${JSON.stringify(f.runtime.kernel.paths.runDir)}))`)
  const calls: Parameters<Kernel["spawnTree"]>[0][] = []
  const kernel = {
    ...f.runtime.kernel,
    spawnTree: (input: Parameters<Kernel["spawnTree"]>[0]) => {
      calls.push(input)
      return { success: false, errorCode: "SPAWN_FAILED", error: "fake" } as const
    },
  }
  spawnFolderProvider(kernel, f.args, { cmd: "fake-provider", args: ["fake"], env: {}, cwd: f.ro })
  if (process.platform === "darwin") expect(calls[0]?.cmd).toBe("/usr/bin/sandbox-exec")
  else if (process.platform === "linux") expect(calls).toHaveLength(0)
  else expect(calls).toHaveLength(0)
})

test("macOS sandbox actually prevents shell writes, sensitive reads and API credential access", async () => {
  if (process.platform !== "darwin") return
  const f = await fixture()
  f.bot.anyFolderAccess = true
  f.bot.access = "full"
  f.bot.folders = [{ path: f.ro, access: "read-only" }]
  writeFileSync(join(f.ro, "keep"), "unchanged")
  writeFileSync(join(f.home, ".ssh/id"), "secret")
  const profile = localFolderProfile(f.runtime.kernel, f.args, { HOME: f.home }, f.home)
  const shell = async (command: string) => {
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output, error }
  }
  expect((await shell(`echo bad > '${join(f.ro, "keep")}'`)).code).not.toBe(0)
  expect(readFileSync(join(f.ro, "keep"), "utf8")).toBe("unchanged")
  expect((await shell(`cat '${join(f.home, ".ssh/id")}'`)).code).not.toBe(0)
  expect((await shell(`cat '${join(f.runtime.kernel.paths.runDir, "handshake.json")}'`)).code).not.toBe(0)
  expect((await shell(`echo yes > '${join(f.rw, "ok")}'`)).code).toBe(0)
  f.bot.folders.push({ path: join(f.home, ".ssh"), access: "read-only" })
  const allowedProfile = localFolderProfile(f.runtime.kernel, f.args, { HOME: f.home }, f.home)
  const allowed = Bun.spawn(["/usr/bin/sandbox-exec", "-p", allowedProfile, "/bin/cat", join(f.home, ".ssh/id")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await allowed.exited).toBe(0)
  expect(await new Response(allowed.stdout).text()).toBe("secret")
})

test("instructions describe explicit folders, permissions, guest paths and exclusions", async () => {
  const f = await fixture()
  f.bot.machine = "vm"
  f.bot.anyFolderAccess = true
  f.bot.folders = [{ path: f.ro, access: "read-only" }]
  const instructions = await composeDeveloperInstructions({
    kernel: f.runtime.kernel,
    bot: f.bot,
    thread: f.args.thread,
    cwd: "/workspace",
  })
  expect(instructions).toContain("Host home → /host/home")
  expect(instructions).toContain(`${JSON.stringify(f.ro)} → ${JSON.stringify(folderGuestPath(f.ro))}: read-only`)
  expect(instructions).toContain("Excluded unless explicitly granted")
  expect(instructions).not.toContain("Host paths are not mounted")
})

test("local profiles canonicalize a live MCP Unix socket without granting the rest of run/", async () => {
  const f = await fixture()
  const server = createServer()
  const socket = join(f.runtime.kernel.paths.runDir, "mcp.sock")
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  try {
    const profile = localFolderProfile(f.runtime.kernel, f.args, { HOME: f.home }, f.home)
    expect(profile).toContain(`(require-not (subpath ${JSON.stringify(socket)}))`)
    expect(profile).not.toContain(`(require-not (subpath ${JSON.stringify(f.runtime.kernel.paths.runDir)}))`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each([false, true])("local profiles allow the resolved MCP socket (explicit path: %s)", (explicit) => {
  const paths = createAppPaths({ appData: `/tmp/${"data-".repeat(30)}` })
  const store = createFixtureStore({ root: paths.appData })
  const bot = store.getBot({ botId: "bot-mark" })
  const thread = store.getThread({ threadId: "thread-mark" })
  if (!bot || !thread) throw new Error("Missing fixture bot or thread")
  const args: StartTurnArgs = {
    bot,
    thread,
    fingerprint: sessionFingerprint({ bot, cwd: "/workspace", mcpCommand: "fixture", mcpArgs: [] }).fingerprint,
    session: null,
    input: [],
    developerInstructions: "",
    handoffPacket: null,
    mcp: { command: "fixture", args: [], env: {} },
    env: {},
    onEvent: () => {},
    signal: new AbortController().signal,
  }
  const socketPath = explicit ? "/tmp/touri-socket-fixture/mcp.sock" : resolveMcpSocketPath(paths)
  const env = explicit ? { TOURI_MCP_SOCK: socketPath } : {}
  const profile = localFolderProfile({ paths } as Kernel, args, env, "/fixture-home")
  expect(profile).toContain(`(subpath ${JSON.stringify(canonicalPath(socketPath))})`)
  expect(profile).toContain(
    `(require-not (subpath ${JSON.stringify(canonicalPath(join(paths.runDir, "mcp-tokens", args.thread.id)))}))`,
  )
  expect(profile).not.toContain(`(require-not (subpath ${JSON.stringify(canonicalPath(paths.runDir))}))`)
})

test("canonical application-data aliases retain only this bot's runtime exceptions", async () => {
  const f = await fixture()
  const alias = join(f.root, "alias")
  symlinkSync(f.runtime.kernel.paths.appData, alias)
  const kernel = { ...f.runtime.kernel, paths: { ...f.runtime.kernel.paths, appData: alias } }
  const profile = localFolderProfile(kernel, f.args, { HOME: f.home }, f.home)
  const appDataRules = profile
    .split("\n")
    .filter((line) => line.startsWith("(deny file-read") && line.includes(f.runtime.kernel.paths.appData))
  expect(appDataRules).toHaveLength(1)
  expect(appDataRules[0]).toContain(`(require-not (subpath ${JSON.stringify(f.bot.homeDir)}))`)
  expect(appDataRules[0]).toContain(
    `(require-not (subpath ${JSON.stringify(join(f.runtime.kernel.paths.runDir, "mcp-tokens", f.args.thread.id))}))`,
  )
  expect(appDataRules[0]).not.toContain(`(require-not (subpath ${JSON.stringify(f.runtime.kernel.paths.runDir)}))`)
})

test("a provider can resolve files while its cwd is inside its protected bot home", async () => {
  if (process.platform !== "darwin") return
  const f = await fixture()
  const scenario = join(f.rw, "scenario.json")
  writeFileSync(scenario, "fixture")
  const profile = localFolderProfile(f.runtime.kernel, f.args, { HOME: f.home }, f.home)
  const child = Bun.spawn(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      profile,
      process.execPath,
      "-e",
      `const fs = require('node:fs'); process.stdout.write(String(fs.existsSync(${JSON.stringify(scenario)})) + ':' + process.env.TOURI_FOLDER_TEST);`,
    ],
    { cwd: f.bot.homeDir, env: { ...process.env, TOURI_FOLDER_TEST: "sentinel" }, stdout: "pipe", stderr: "pipe" },
  )
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(output).toBe("true:sentinel")
})
