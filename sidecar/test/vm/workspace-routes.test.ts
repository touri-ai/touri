import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, MachineState, UiEventEnvelope, VmRuntime } from "@touri/contracts"
import { machineActionRoutes } from "../../src/vm/machine-actions"
import { botWorkspaceRoutes } from "../../src/vm/workspace-routes"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(import.meta.dirname, ".workspace-"))
  roots.push(root)
  let bot = {
    id: "bot",
    homeDir: root,
    cwd: null,
    projectId: null,
    machine: "local",
    computerUse: true,
    access: "workspace-write",
    archivedAt: null,
    paused: false,
  } as Bot
  const services = new Map<string, unknown>([["store.api", { getBot: () => bot }]])
  let listener: ((event: UiEventEnvelope) => void) | undefined
  const kernel = {
    paths: { appData: join(root, "app-data") },
    services: {
      use: (name: string) => services.get(name),
      provide: (name: string, value: unknown) => services.set(name, value),
    },
    redact: (value: string) => value,
    onHostNotification: () => () => {},
    subscribe: (next: typeof listener) => {
      listener = next
      return () => {}
    },
  } as unknown as Kernel
  let acquired = 0
  let released = 0
  const calls: Array<Parameters<VmRuntime["exec"]>[0]> = []
  let executor = async (input: Parameters<VmRuntime["exec"]>[0]) => {
    calls.push(input)
    return { success: true as const, stdout: '{"files":[]}', stderr: "", code: 0 }
  }
  const state = { botId: "bot", status: "running" } as MachineState
  let intent = ""
  const vm = {
    states: () => [state],
    acquire: async () => {
      acquired++
      return async () => {
        released++
      }
    },
    exec: (input: Parameters<VmRuntime["exec"]>[0]) => executor(input),
    intent: async (input: { intent: string }) => {
      intent = input.intent
      return state
    },
  } as unknown as VmRuntime
  const routes = botWorkspaceRoutes(kernel, vm)
  const request = async (path: string, query = {}, body: unknown = {}) => {
    const route = routes.find((route) => route.path === path)
    if (!route) throw new Error("Missing route")
    return route.handler({ params: { id: "bot" }, query, body, signal: new AbortController().signal })
  }
  return {
    root,
    kernel,
    vm,
    calls,
    request,
    services,
    counts: () => ({ acquired, released }),
    intent: () => intent,
    setBot: (patch: Partial<Bot>) => {
      bot = { ...bot, ...patch }
      listener?.({ seq: 1, at: Date.now(), event: { type: "bot.updated", bot } })
    },
    setStatus: (status: MachineState["status"]) => {
      state.status = status
    },
    setExecutor: (value: typeof executor) => {
      executor = value
    },
  }
}

test("library browses regular files, rejects traversal, hidden files, links and oversized downloads", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "notes.md"), "# Notes")
  mkdirSync(join(f.root, "docs"))
  writeFileSync(join(f.root, ".secret"), "secret")
  symlinkSync("notes.md", join(f.root, "link"))
  const list = await f.request("/bots/:id/files")
  expect(list.status).toBe(200)
  expect("json" in list && list.json).toMatchObject({
    files: [
      { name: "docs", directory: true },
      { name: "notes.md", directory: false },
    ],
  })
  const read = await f.request("/bots/:id/files/content", { path: "notes.md" })
  expect("json" in read && read.json).toMatchObject({
    name: "notes.md",
    base64: Buffer.from("# Notes").toString("base64"),
  })
  for (const path of ["../notes.md", ".secret", "docs/../notes.md", "bad\0path"])
    expect((await f.request("/bots/:id/files/content", { path })).status).toBe(400)
  expect((await f.request("/bots/:id/files/content", { path: "link" })).status).toBe(422)
  writeFileSync(join(f.root, "large.bin"), Buffer.alloc(524_289))
  expect((await f.request("/bots/:id/files/content", { path: "large.bin" })).status).toBe(422)
})

test("chat file paths are confined to this bot's workspace, home and granted folders", async () => {
  const f = fixture()
  const other = fixture()
  const granted = join(other.root, "shared")
  mkdirSync(granted)
  writeFileSync(join(f.root, "notes.md"), "# Notes")
  writeFileSync(join(granted, "report.txt"), "Shared")
  writeFileSync(join(other.root, "private.txt"), "Private")
  f.setBot({ folders: [{ path: granted, access: "read-only" }] })
  for (const path of [join(f.root, "notes.md"), join(granted, "report.txt")])
    expect((await f.request("/bots/:id/files/content", { path })).status).toBe(200)
  for (const path of [join(other.root, "private.txt"), `${granted}-other/report.txt`, "/etc/passwd"])
    expect((await f.request("/bots/:id/files/content", { path })).status).toBe(403)
  expect((await f.request("/bots/:id/files/content", { path: `${granted}/../private.txt` })).status).toBe(400)
  symlinkSync(other.root, join(f.root, "escape"))
  expect((await f.request("/bots/:id/files/content", { path: join(f.root, "escape/private.txt") })).status).toBe(422)
  const missing = await f.request("/bots/:id/files/content", { path: join(f.root, "missing.md") })
  expect(missing.status).toBe(422)
  expect("json" in missing && missing.json).toMatchObject({ error: expect.stringContaining("removido") })
  f.setBot({ folders: [] })
  expect((await f.request("/bots/:id/files/content", { path: join(granted, "report.txt") })).status).toBe(403)
})

test("absolute guest paths stay on the bot's machine and never read the host", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "host.md"), "Host only")
  for (const machine of ["vm", "cloud"] as const) {
    f.setBot({ machine })
    expect((await f.request("/bots/:id/files/content", { path: "/workspace/notes.md" })).status).toBe(200)
    expect(f.calls.at(-1)?.args?.slice(-2)).toEqual(["read", "notes.md"])
    expect((await f.request("/bots/:id/files/content", { path: join(f.root, "host.md") })).status).toBe(403)
  }
})

test("broad folder access still excludes application data unless explicitly granted", async () => {
  const f = fixture()
  const shared = mkdtempSync(join(tmpdir(), "touri-shared-"))
  roots.push(shared)
  const appData = join(f.root, "app-data")
  mkdirSync(appData)
  writeFileSync(join(appData, "private.txt"), "Private")
  writeFileSync(join(shared, "report.txt"), "Report")
  f.setBot({ anyFolderAccess: true })
  expect((await f.request("/bots/:id/files/content", { path: join(shared, "report.txt") })).status).toBe(200)
  expect((await f.request("/bots/:id/files/content", { path: join(appData, "private.txt") })).status).toBe(403)
  f.setBot({ folders: [{ path: appData, access: "read-only" }] })
  expect((await f.request("/bots/:id/files/content", { path: join(appData, "private.txt") })).status).toBe(200)
})

test("home files remain readable when a bot has a separate workspace", async () => {
  const f = fixture()
  const project = fixture()
  writeFileSync(join(f.root, "home.md"), "Home")
  writeFileSync(join(project.root, "notes.md"), "Project")
  f.setBot({ cwd: project.root })
  for (const path of ["notes.md", join(project.root, "notes.md"), join(f.root, "home.md")])
    expect((await f.request("/bots/:id/files/content", { path })).status).toBe(200)
})

test("a granted folder whose ancestor was replaced with a symlink is refused", async () => {
  const f = fixture()
  const other = fixture()
  const parent = join(other.root, "parent")
  const granted = join(parent, "shared")
  const replacement = join(other.root, "replacement")
  mkdirSync(granted, { recursive: true })
  mkdirSync(join(replacement, "shared"), { recursive: true })
  writeFileSync(join(replacement, "shared/private.txt"), "Private")
  f.setBot({ folders: [{ path: granted, access: "read-only" }] })
  renameSync(parent, `${parent}-old`)
  symlinkSync(replacement, parent)
  expect((await f.request("/bots/:id/files/content", { path: join(granted, "private.txt") })).status).toBe(403)
})

test("VM library uses a lease, guest path arguments and releases on exec failure", async () => {
  const f = fixture()
  f.setBot({ machine: "vm" })
  expect((await f.request("/bots/:id/files", { path: "docs" })).status).toBe(200)
  expect(f.calls[0]?.command).toBe("python3")
  expect(f.calls[0]?.args?.slice(-2)).toEqual(["list", "docs"])
  expect(f.counts()).toEqual({ acquired: 1, released: 1 })
  f.setExecutor(async () => {
    throw new Error("Guest indisponível")
  })
  expect((await f.request("/bots/:id/files")).status).toBe(422)
  expect(f.counts()).toEqual({ acquired: 2, released: 2 })
})

test("shell fails closed for host/read-only/paused bots or absent computer permission", async () => {
  for (const patch of [
    { machine: "local" },
    { machine: "vm", access: "read-only" },
    { machine: "vm", computerUse: false },
    { machine: "vm", paused: true },
  ] as Partial<Bot>[]) {
    const f = fixture()
    f.setBot(patch)
    expect((await f.request("/bots/:id/machine/shell", {}, { command: "pwd" })).status).toBe(403)
    expect(f.counts().acquired).toBe(0)
  }
})

test("shell uses bounded guest exec and releases its lease after the kill switch", async () => {
  const f = fixture()
  f.setBot({ machine: "vm" })
  let executing: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    executing = resolve
  })
  f.setExecutor(async (input) => {
    f.calls.push(input)
    if (!input.args?.[1]?.includes("selectors")) return { success: true, stdout: "{}", stderr: "", code: 0 }
    executing?.()
    return new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(new Error("Interrompido"))))
  })
  const result = f.request("/bots/:id/machine/shell", {}, { command: "sleep 100" })
  await started
  expect(f.calls[0]?.command).toBe("python3")
  expect(f.calls[0]?.args?.[2]).toMatch(/^\/tmp\/touri-shell-[a-f0-9]{32}$/)
  expect(f.calls[0]?.args?.[3]).toBe("sleep 100")
  expect((await f.request("/bots/:id/machine/shell", {}, { command: "pwd" })).status).toBe(409)
  ;(f.services.get("vm.stopShells") as () => void)()
  expect((await result).status).toBe(422)
  expect(f.counts()).toEqual({ acquired: 1, released: 1 })
})

test("COMPUTER_OPEN is accepted through the existing pre-thaw intent route", async () => {
  const f = fixture()
  const route = machineActionRoutes(f.kernel, f.vm).find((entry) => entry.path === "/bots/:id/machine/intent")
  const result = await route?.handler({
    params: { id: "bot" },
    query: {},
    body: { intent: "computer-open" },
    signal: new AbortController().signal,
  })
  expect(result?.status).toBe(200)
  expect(f.intent()).toBe("computer-open")
})

test("library browsing and report reads never wake a stopped VM", async () => {
  const f = fixture()
  f.setBot({ machine: "vm" })
  f.setStatus("stopped")
  expect((await f.request("/bots/:id/files")).status).toBe(409)
  expect((await f.request("/bots/:id/files/content", { path: "report.md" })).status).toBe(409)
  expect(f.counts()).toEqual({ acquired: 0, released: 0 })
  expect(f.calls).toHaveLength(0)
})

test("files/content returns binary files byte for byte, with no UTF-8 decoding or data-URL prefix", async () => {
  const f = fixture()
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    Buffer.from([0xef, 0xbf, 0xbd, 0xc3, 0x28, 0xff, 0xd9]),
  ])
  writeFileSync(join(f.root, "shot.jpg"), jpeg)
  const read = await f.request("/bots/:id/files/content", { path: "shot.jpg" })
  const body = "json" in read ? (read.json as { mime: string; base64: string }) : null
  expect(body?.mime).toBe("image/jpeg")
  expect(body?.base64.startsWith("data:")).toBe(false)
  expect(Buffer.from(body?.base64 ?? "", "base64").equals(jpeg)).toBe(true)
})
