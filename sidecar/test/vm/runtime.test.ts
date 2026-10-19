import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderAdapter, StartTurnArgs, ToolRegistration, VmRuntime } from "@touri/contracts"
import type { WebSocketOptions } from "bun"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { createBrowserStore } from "../../src/browser/store"
import { createRoutedBrowserEngine } from "../../src/browser/vm-router"
import { init as initComputer } from "../../src/computer"
import { createKernel } from "../../src/kernel"
import { authenticateMcp } from "../../src/mcp/auth"
import { createProjectStore } from "../../src/projects/repository"
import { createSupervisor } from "../../src/projects/supervisor"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { sessionFingerprint } from "../../src/runtime/session"
import { startVmTurn } from "../../src/runtime/vm-turn"
import { init as initStore } from "../../src/store"
import { BOT_IMAGE } from "../../src/vm/image"
import { machineActionRoutes } from "../../src/vm/machine-actions"
import { ProviderLoginError, providerLoginAccount, readProviderLogin } from "../../src/vm/provider-login"
import { redactVmEvents } from "../../src/vm/redact-events"
import { createVmRuntime, GUEST_READY_COMMAND } from "../../src/vm/runtime"
import { MachineServiceError } from "../../src/vm/service-error"
import type { VmCreateOptions } from "../../src/vm/types"
import { vncPasswordFile } from "../../src/vm/vnc-auth"
import { socketTicket } from "../fakes/ws-ticket"
import { fakeVmProvider } from "./fake-provider"

const cleanups: Array<() => Promise<void>> = []
const deferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const fixture = async (
  available = true,
  timeouts: { boot?: number; ready?: number; auth?: number; exec?: number; service?: number } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-vm-unit-"))
  const hostHome = join(root, "host-home")
  mkdirSync(join(hostHome, ".codex"), { recursive: true })
  writeFileSync(join(hostHome, ".codex/auth.json"), JSON.stringify({ access_token: "only-provider-secret" }))
  writeFileSync(join(hostHome, "decoy-secret"), "never-copy-this")
  const runtime = createKernel({ appData: join(root, "data") })
  await initStore(runtime.kernel)
  const fake = fakeVmProvider()
  const connectionKeys = new Map<string, Buffer>()
  let clock = Date.now()
  const vm = createVmRuntime({
    kernel: runtime.kernel,
    provider: fake.provider,
    hostHome,
    timeouts,
    connectionKeys: {
      rotate: async (id) => {
        const key = randomBytes(32)
        connectionKeys.set(id, Buffer.from(key))
        return key
      },
      remove: async (id) => {
        connectionKeys.delete(id)
      },
    },
    now: () => clock,
    capability: {
      available,
      reason: available ? null : "sem virtualização neste host",
      provider: available ? "fake" : null,
    },
  })
  runtime.kernel.services.provide("vm.runtime", vm.service)
  const request = async (path: string, body: unknown = {}, method = "POST") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "vm-test",
        "Content-Type": "application/json",
      },
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
    })
  cleanups.push(async () => {
    await vm.dispose()
    runtime.emitHostNotification({ method: "app.willQuit", params: {} })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const bot = async (input: Partial<Bot> = {}) => {
    const response = await request("/bots", { name: "VM", provider: "codex", machine: "vm", ...input })
    expect(response.status).toBe(201)
    const bot = ((await response.json()) as { bot: Bot }).bot
    if (bot.provider === "codex" || bot.provider === "opencode")
      (runtime.kernel.db as Database)
        .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES (?,?,?)")
        .run(`vm-login-source:${bot.id}:${bot.provider}`, '"host-file"', Date.now())
    return bot
  }
  return {
    root,
    runtime,
    vm,
    fake,
    connectionKeys,
    request,
    bot,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test("late release of turn A cannot remove turn B's MCP token on the same thread", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const threadId = bot.mainThreadId ?? "thread"
  const original = f.fake.provider.exec
  const entered = deferred()
  const cleanup = deferred()
  f.fake.provider.exec = async (input) => {
    if (input.command === "rm" && input.args?.some((arg) => arg.endsWith(".token"))) {
      entered.resolve()
      await cleanup.promise
      for (const path of input.args ?? []) f.fake.files.delete(path)
    }
    return original(input)
  }
  const one = await f.vm.service.prepareTurn({ botId: bot.id, threadId, token: "turn-a" })
  const releasing = one.release()
  await entered.promise
  try {
    const two = await f.vm.service.prepareTurn({ botId: bot.id, threadId, token: "turn-b" })
    cleanup.resolve()
    await releasing
    const path = two.mcp.args.at(-1) ?? ""
    expect(path).toMatch(/\/run\/.*\.token$/)
    expect(path).not.toBe(one.mcp.args.at(-1))
    expect(f.fake.files.get(path)).toBe("turn-b")
    const tokenId = path.split(".").at(-2)
    const auth = (token: string, id = tokenId) =>
      authenticateMcp({
        line: JSON.stringify({ touriAuth: { thread: threadId, token, tokenId: id } }),
        tokenDir: join(f.runtime.kernel.paths.runDir, "mcp-tokens"),
        database: f.runtime.kernel.db as Database,
        kernel: f.runtime.kernel,
      })
    expect(auth("turn-b").success).toBe(true)
    expect(auth("turn-a", one.mcp.args.at(-1)?.split(".").at(-2)).success).toBe(false)
    await one.release()
    expect(auth("turn-b").success).toBe(true)
    await two.release()
    expect(auth("turn-b").success).toBe(false)
    expect(f.fake.files.has(path)).toBe(false)
  } finally {
    cleanup.resolve()
    await releasing
  }
})

test("APP_BACKGROUND followed by exec and Preview close honors ten minutes since last activity", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 10 })
  const release = await f.vm.service.acquire({ botId: bot.id })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  await release()
  await f.vm.service.exec({ botId: bot.id, command: "echo" })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-visible", viewerId: "preview" })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-hidden", viewerId: "preview" })
  f.advance(2983)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(600_000 - 2983 - 1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.pauseReason).toBe("inactivity")
})

test.each(["resume", "bad-resume", "app_restart"] as const)(
  "VM engine supplies a fresh run token for %s, including lazy MCP refresh",
  async (mode) => {
    const f = await fixture()
    const bot = await f.bot()
    const threadId = bot.mainThreadId ?? ""
    const store = f.runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Missing store")
    const scenario = join(f.root, "scenario.json")
    const requests = join(f.root, "requests.jsonl")
    writeFileSync(scenario, JSON.stringify({ requestLogPath: requests, deltas: ["ok"] }))
    const spawn = f.fake.provider.spawn
    const tokenPaths: string[] = []
    const guestExits: Array<Promise<unknown>> = []
    f.fake.provider.spawn = (input) => {
      if (input.command !== "codex") return spawn(input)
      const config = input.args?.find((arg) => arg.startsWith("mcp_servers.touri.args="))
      const mcpArgs = JSON.parse(config?.slice("mcp_servers.touri.args=".length) ?? "[]") as string[]
      const path = mcpArgs.at(-1) ?? ""
      tokenPaths.push(path)
      expect(f.fake.files.get(path)).toBeTruthy()
      const child = f.runtime.kernel.spawnTree({
        cmd: process.execPath,
        args: ["run", join(import.meta.dir, "../fakes/fake-codex.ts"), ...(input.args ?? [])],
        cwd: f.root,
        env: { ...process.env, TOURI_FAKE_SCENARIO: scenario },
      })
      if (child.success) guestExits.push(child.exited)
      return child
    }
    let engine = createRuntimeEngine({ kernel: f.runtime.kernel })
    const send = () => {
      const request = store.insertMessage({
        message: {
          id: f.runtime.kernel.newId(),
          threadId,
          parentId: store.getThread({ threadId })?.activeLeafId ?? null,
          role: "user",
          kind: "text",
          status: "complete",
          runId: null,
          text: "Abra o navegador",
          parts: [],
          sender: null,
          source: "local",
        },
      })
      if (!request.success) throw new Error(request.error)
      const started = engine.enqueue({ threadId, requestMessageId: request.message.id, trigger: "user" })
      if (!started.success) throw new Error(started.error)
      return started.run
    }
    try {
      const first = send()
      await waitForTerminal(first)
      expect(first.status).toBe("succeeded")
      expect(f.fake.files.has(tokenPaths[0] ?? "")).toBe(false)
      writeFileSync(
        scenario,
        JSON.stringify({
          requestLogPath: requests,
          ...(mode === "bad-resume" ? { badResume: true } : {}),
          ...(mode === "app_restart"
            ? { events: [{ type: "delta", delta: "partial" }, { type: "sleep" }], slowMs: 1000 }
            : { deltas: ["next"] }),
        }),
      )
      let next = send()
      if (mode === "app_restart") {
        for (let i = 0; i < 200 && next.status !== "running"; i++) await Bun.sleep(5)
        expect(next.status).toBe("running")
        await engine.shutdown()
        expect(next.errorClass).toBe("app_restart")
        writeFileSync(scenario, JSON.stringify({ requestLogPath: requests, deltas: ["recovered"] }))
        engine = createRuntimeEngine({ kernel: f.runtime.kernel })
        const retry = engine.retry(next.id)
        if (!retry.success) throw new Error(retry.error)
        next = retry.run
      }
      await waitForTerminal(next)
      expect(next.status).toBe("succeeded")
      expect(tokenPaths[1]).not.toBe(tokenPaths[0])
      if (mode === "app_restart") expect(tokenPaths[2]).not.toBe(tokenPaths[1])
      const frames = readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const sessions = frames.filter((frame) => ["thread/start", "thread/resume"].includes(frame.method))
      expect(sessions[1]?.method).toBe("thread/resume")
      expect(sessions.at(-1)?.method).toBe(mode === "resume" ? "thread/resume" : "thread/start")
      for (const frame of sessions) {
        const path = frame.params.config.mcp_servers.touri.args.at(-1)
        expect(tokenPaths).toContain(path)
        expect(path).toMatch(/\.[a-f0-9]{32}\.token$/)
      }
      expect(sessions.at(-1)?.params.config.mcp_servers.touri.args.at(-1)).toBe(tokenPaths.at(-1))
      for (const path of tokenPaths) expect(f.fake.files.has(path)).toBe(false)
    } finally {
      await engine.shutdown()
      // Drain real fake-guest child callbacks before the fixture closes its DB.
      await Promise.all(guestExits)
    }
  },
)

test("exec activity is shared with another VM runtime and restarts the ten-minute idle window", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 10 })
  const release = await f.vm.service.acquire({ botId: bot.id })
  await release()
  const observer = createVmRuntime({ kernel: f.runtime.kernel, provider: f.fake.provider, now: f.now })
  try {
    f.advance(601_000)
    await f.vm.service.exec({ botId: bot.id, command: "echo", args: ["used at t0"] })
    for (const elapsed of [10_772, 589_227]) {
      f.advance(elapsed)
      await observer.sweep()
      expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
    }
    f.advance(1)
    await observer.sweep()
    expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(1)
  } finally {
    await observer.dispose()
  }
})

test("an exec in progress protects the VM and completion renews idle activity", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 10 })
  const release = await f.vm.service.acquire({ botId: bot.id })
  await release()
  f.advance(601_000)
  const gate = deferred()
  const original = f.fake.provider.exec
  f.fake.provider.exec = async (args) => {
    await gate.promise
    return original(args)
  }
  const execution = f.vm.service.exec({ botId: bot.id, command: "echo" })
  try {
    await f.vm.sweep()
    expect(f.vm.service.states()[0]?.status).toBe("running")
  } finally {
    gate.resolve()
    await execution
  }
  f.advance(599_999)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("stopped")
})

test("VM runtime replacement preserves the remaining idle window", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 10 })
  const release = await f.vm.service.acquire({ botId: bot.id })
  await release()
  f.advance(300_000)
  const replacement = createVmRuntime({ kernel: f.runtime.kernel, provider: f.fake.provider, now: f.now })
  try {
    f.advance(299_999)
    await replacement.sweep()
    expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
    f.advance(1)
    await replacement.sweep()
    expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(1)
  } finally {
    await replacement.dispose()
  }
})

test("reacquiring a warm idle VM keeps the desktop mounted while checking its image", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const states: string[] = []
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
    if (event.type === "machine.updated" && event.machine.botId === bot.id) states.push(event.machine.status)
  })
  const offset = f.fake.calls.length
  await (await f.vm.service.acquire({ botId: bot.id }))()
  unsubscribe()
  expect(f.fake.calls.slice(offset).some((call) => call.action === "inspect")).toBe(true)
  expect(states).not.toContain("starting")
  expect(f.vm.service.states()[0]?.status).toBe("running")
})

test("a running-only viewer lease reconnects without image, readiness or boot preparation", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await expect(f.vm.service.acquire({ botId: bot.id, runningOnly: true })).rejects.toThrow("não está em execução")
  expect(f.fake.calls).toHaveLength(0)
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const offset = f.fake.calls.length
  const release = await f.vm.service.acquire({ botId: bot.id, runningOnly: true })
  expect(f.fake.calls.slice(offset)).toEqual([])
  expect(f.vm.service.states()[0]?.status).toBe("running")
  await release()
})

test("canceling a warm acquisition leaves the running machine and existing leases intact", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const release = await f.vm.service.acquire({ botId: bot.id })
  const ready = deferred()
  const entered = deferred()
  const exec = f.fake.provider.exec
  f.fake.provider.exec = async (input) => {
    if (input.args?.includes(GUEST_READY_COMMAND)) {
      entered.resolve()
      await ready.promise
    }
    return exec(input)
  }
  const controller = new AbortController()
  const pending = f.vm.service.acquire({ botId: bot.id, signal: controller.signal })
  const rejected = pending.then(
    () => null,
    (error: unknown) => error,
  )
  await entered.promise
  controller.abort()
  expect(await rejected).toBeInstanceOf(Error)
  expect(f.vm.service.states()[0]?.status).toBe("running")
  expect(f.fake.calls.some((call) => call.action === "stop")).toBe(false)
  ready.resolve()
  await release()
})

test("workspace browser snapshot restores guest tab ownership without launching any browser", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const other = await f.bot()
  const store = createBrowserStore({ kernel: f.runtime.kernel, profile: `vm:${bot.id}` })
  const tab = store.create({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    url: "https://touri.ai/",
    openerTabId: null,
    targetId: "guest-target",
  })
  tab.info.title = "touri.ai"
  store.save(tab)
  let hostSpawns = 0
  const browser = createRoutedBrowserEngine(
    {
      ...f.runtime.kernel,
      spawnTree: () => {
        hostSpawns += 1
        return { success: false, errorCode: "SPAWN_FAILED", error: "host forbidden" }
      },
    },
    "system-chrome",
  )
  try {
    expect(browser.tabsForBot(null)).toContainEqual(
      expect.objectContaining({
        tabId: tab.info.tabId,
        ownerBotId: bot.id,
        url: "https://touri.ai/",
        title: "touri.ai",
      }),
    )
    expect(browser.tabsForBot(other.id)).toEqual([])
    expect(hostSpawns).toBe(0)
    expect(f.fake.calls).toEqual([])
  } finally {
    await browser.shutdown()
  }
})

test("bot VM is lazy, serializes first creation, reuses storage, stops idle and resumes", async () => {
  const f = await fixture()
  const bot = await f.bot()
  expect(bot).toMatchObject({ machine: "vm", machineIdleMinutes: 10, vmProviderLogin: false, hostComputerUse: false })
  expect(f.fake.calls).toHaveLength(0)
  const [a, b] = await Promise.all([f.vm.service.acquire({ botId: bot.id }), f.vm.service.acquire({ botId: bot.id })])
  expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(1)
  f.advance(16 * 60_000)
  await f.vm.sweep()
  expect(f.fake.calls.some((call) => call.action === "stop")).toBe(false)
  await a()
  await b()
  f.advance(10 * 60_000 - 1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  const volume = [...f.fake.volumes][0]
  f.fake.files.set("/workspace/retained", "data")
  f.advance(1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", pauseReason: "inactivity", memoryMb: 1536 })
  expect(f.fake.volumes.has(volume ?? "")).toBe(true)
  expect(f.fake.files.get("/workspace/retained")).toBe("data")
  const resume = await f.vm.service.acquire({ botId: bot.id })
  await resume()
  expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(1)
  expect(f.fake.calls.filter((call) => call.action === "start")).toHaveLength(2)
  await f.vm.service.restart({ botId: bot.id, reset: true })
  expect(f.fake.calls.filter((call) => call.action === "deleteVolume")).toHaveLength(2)
  await f.vm.service.destroy({ botId: bot.id })
  expect(f.fake.volumes.size).toBe(0)
})

test("bot VM memory preference is validated, persists, and sets creation and reported caps", async () => {
  const f = await fixture()
  const defaults = await f.request("/settings", {}, "GET")
  expect((await defaults.json()).settings.botVmMemoryMb).toBe(1536)
  for (const value of [0, 511, 16385, 1024.5, "1536", null])
    expect((await f.request("/settings", { botVmMemoryMb: value }, "PATCH")).status).toBe(400)
  expect((await f.request("/settings", { botVmMemoryMb: 1024 }, "PATCH")).status).toBe(200)
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const created = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
  expect(created?.memoryMb).toBe(1024)
  expect(f.vm.service.states()[0]?.memoryMb).toBe(1024)
  expect((await (await f.request("/settings", {}, "GET")).json()).settings.botVmMemoryMb).toBe(1024)
  // A warm guest keeps its actual cap until recreation; preferences do not lie about it.
  await f.request("/settings", { botVmMemoryMb: 1536 }, "PATCH")
  await (await f.vm.service.acquire({ botId: bot.id }))()
  expect(f.vm.service.states()[0]?.memoryMb).toBe(1024)
})

test("guest Chromium starts with memory limits while keeping its desktop profile and debug port", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }),
  })
  const exec = f.fake.provider.exec
  f.fake.provider.exec = async (input) =>
    input.command === "curl" ? { success: false, errorCode: "NOT_RUNNING", error: "browser stopped" } : exec(input)
  const forward = f.fake.provider.forwardPort
  f.fake.provider.forwardPort = async (input) =>
    input.guestPort === 9222 ? forward({ ...input, hostPort: server.port ?? 0 }) : forward(input)
  try {
    expect(await f.vm.service.browserEndpoint({ botId: bot.id })).toContain("/devtools/browser/fake")
    const execs = f.fake.calls
      .filter((call) => call.action === "exec")
      .map((call) => call.input as { command: string; args: string[]; user?: string })
    const clear = execs.findIndex((input) => input.command === "python3" && input.args.join(" ").includes("Singleton"))
    const launchAt = execs.findIndex(
      (input) => input.command === "sh" && input.args.includes("--remote-debugging-port=9222"),
    )
    expect(clear).toBeGreaterThanOrEqual(0)
    expect(launchAt).toBeGreaterThan(clear)
    expect(execs[clear]?.user).toBe("0")
    const launch = execs[launchAt]
    expect(launch?.user).toBe("1001")
    expect(launch?.args).not.toContain("--no-sandbox")
    expect(launch?.args).toEqual(
      expect.arrayContaining([
        "--renderer-process-limit=2",
        "--disable-features=BackForwardCache",
        "--js-flags=--max-old-space-size=512",
        "--remote-debugging-port=9222",
        "--user-data-dir=/var/lib/touri-browser/profile",
      ]),
    )
  } finally {
    server.stop(true)
  }
})

test("browserEndpoint runningOnly never boots a stopped VM or launches missing Chromium", async () => {
  const f = await fixture()
  const bot = await f.bot()
  expect(await f.vm.service.browserEndpoint({ botId: bot.id, runningOnly: true })).toBeNull()
  expect(f.fake.calls).toEqual([])
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const exec = f.fake.provider.exec
  for (const transportFailure of [false, true]) {
    f.fake.provider.exec = async (input) =>
      input.command === "curl"
        ? transportFailure
          ? { success: false, errorCode: "NOT_RUNNING", error: "browser stopped" }
          : { success: true, code: 7, stdout: "", stderr: "connection refused" }
        : exec(input)
    expect(await f.vm.service.browserEndpoint({ botId: bot.id, runningOnly: true })).toBeNull()
  }
  expect(
    f.fake.calls.some(
      (call) =>
        call.action === "exec" &&
        ["chromium", "sh", "python3"].includes((call.input as { command: string }).command) &&
        (call.input as { args?: string[] }).args?.some(
          (arg) => arg.includes("remote-debugging-port") || arg.includes("Singleton"),
        ),
    ),
  ).toBe(false)
  expect(
    f.fake.calls.some((call) => call.action === "forward" && (call.input as { guestPort: number }).guestPort === 9222),
  ).toBe(false)
})

test("a canceled browser port forward cannot poison VM serialization for the next call", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const forward = f.fake.provider.forwardPort
  const reached = deferred()
  f.fake.provider.forwardPort = async (input) => {
    if (input.guestPort !== 9222) return forward(input)
    reached.resolve()
    return new Promise(() => {}) // Provider ignores cancellation and never settles.
  }
  const controller = new AbortController()
  const pending = f.vm.service
    .browserEndpoint({ botId: bot.id, runningOnly: true, signal: controller.signal })
    .catch((error: unknown) => error)
  await reached.promise
  controller.abort(new Error("test canceled"))
  expect(await pending).toBeInstanceOf(Error)
  f.fake.provider.forwardPort = forward
  const release = await f.vm.service.acquire({ botId: bot.id, signal: AbortSignal.timeout(200) })
  await release()
  expect(f.vm.service.states()[0]?.status).toBe("running")
})

test("VNC passwords are private, redacted, sealed and rotated on restart and external stop", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const first = await f.vm.service.desktopConnection({ botId: bot.id })
  expect(first.password).toHaveLength(8)
  expect(f.runtime.kernel.redact(first.password)).not.toContain(first.password)
  expect(JSON.stringify(f.vm.service.states())).not.toContain(first.password)
  const sealed = [...f.fake.files.entries()].find(([path]) => path.endsWith("connection.sealed.json"))?.[1] ?? ""
  expect(sealed).not.toContain(first.password)
  expect(sealed).not.toContain(vncPasswordFile(first.password).toString("base64"))
  const events = await (await f.request("/machines", {}, "GET")).text()
  expect(events).not.toContain(first.password)
  expect(JSON.stringify(f.fake.calls)).not.toContain(first.password)
  expect(JSON.stringify(f.fake.calls)).not.toContain(vncPasswordFile(first.password).toString("base64"))
  f.runtime.kernel.log({
    level: "info",
    module: "vm",
    msg: first.password,
    data: { passwordFile: vncPasswordFile(first.password).toString("base64") },
  })
  const log = readFileSync(join(f.runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")
  expect(log).not.toContain(first.password)
  expect(log).not.toContain(vncPasswordFile(first.password).toString("base64"))
  await f.vm.service.restart({ botId: bot.id })
  const second = await f.vm.service.desktopConnection({ botId: bot.id })
  expect(second.password).not.toBe(first.password)
  const id = [...f.fake.machines.keys()][0] ?? ""
  f.fake.machines.set(id, "stopped")
  await (await f.vm.service.acquire({ botId: bot.id }))()
  expect((await f.vm.service.desktopConnection({ botId: bot.id })).password).not.toBe(second.password)
  await f.vm.service.stop({ botId: bot.id })
  await expect(f.vm.service.desktopConnection({ botId: bot.id })).rejects.toThrow()
})

test.each([
  ["running", "touri-bot:1"],
  ["stopped", "touri-bot:1"],
  ["running", "touri-bot:2"],
  ["stopped", "touri-bot:2"],
  ["running", "touri-bot:4"],
  ["stopped", "touri-bot:4"],
] as const)("outdated %s VM (%s) is replaced using its actual persistent mount", async (status, image) => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const original = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
  const mount = { type: "volume" as const, source: "existing-user-data", target: "/workspace" }
  f.fake.configs.set(original.name, { ...original, image, volumes: [mount] })
  f.fake.machines.set(original.name, status)
  f.fake.files.set("/workspace/user-file", "user data")
  f.fake.files.set("/workspace/.home/.codex/config.toml", "user home")
  const events: Array<import("@touri/contracts").UiEvent> = []
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => events.push(event))
  const offset = f.fake.calls.length
  try {
    await (await f.vm.service.acquire({ botId: bot.id }))()
  } finally {
    unsubscribe()
  }
  const calls = f.fake.calls.slice(offset)
  const replacement = calls.find((call) => call.action === "create")?.input as VmCreateOptions
  expect(replacement.image).toBe(BOT_IMAGE)
  expect(replacement.volumes).toContainEqual(mount)
  expect(calls.filter((call) => call.action === "destroy")).toHaveLength(1)
  expect(calls.filter((call) => call.action === "stop")).toHaveLength(status === "running" ? 1 : 0)
  expect(calls.some((call) => ["deleteVolume", "migrateWorkspace"].includes(call.action))).toBe(false)
  expect(f.fake.files.get("/workspace/user-file")).toBe("user data")
  expect(f.fake.files.get("/workspace/.home/.codex/config.toml")).toBe("user home")
  expect(
    events.some(
      (event) =>
        event.type === "machine.updated" && event.machine.progress === "Atualizando a máquina para a versão nova…",
    ),
  ).toBe(true)
  expect(readFileSync(join(f.runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")).toContain('"stage":"upgrade"')
})

test.each([BOT_IMAGE, `docker.io/library/${BOT_IMAGE}`])(
  "matching image %s reuses a stopped container",
  async (image) => {
    const f = await fixture()
    const bot = await f.bot()
    await (await f.vm.service.acquire({ botId: bot.id }))()
    await f.vm.service.stop({ botId: bot.id })
    const original = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
    f.fake.configs.set(original.name, { ...original, image })
    const offset = f.fake.calls.length
    await (await f.vm.service.acquire({ botId: bot.id }))()
    expect(f.fake.calls.slice(offset).map((call) => call.action)).toEqual([
      "inspect",
      "start",
      "exec",
      "exec",
      "spawn",
      "spawn",
    ])
  },
)

test("legacy rootfs workspace migrates before deletion, and a failed recreation retries the same bind", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const original = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
  f.fake.configs.set(original.name, { ...original, image: "touri-bot:1", volumes: [] })
  const create = f.fake.provider.create
  f.fake.provider.create = async () => ({ success: false, errorCode: "COMMAND_FAILED", error: "recreate failed" })
  const offset = f.fake.calls.length
  await expect(f.vm.service.acquire({ botId: bot.id })).rejects.toThrow("recreate failed")
  const calls = f.fake.calls.slice(offset)
  expect(calls.findIndex((call) => call.action === "migrateWorkspace")).toBeLessThan(
    calls.findIndex((call) => call.action === "destroy"),
  )
  const meta = (f.runtime.kernel.db as Database)
    .query("SELECT volume FROM bot_machines WHERE bot_id = ?")
    .get(bot.id) as { volume: string }
  const mount = (JSON.parse(meta.volume) as VmCreateOptions["volumes"])?.[0]
  expect(mount).toMatchObject({ type: "bind", target: "/workspace" })
  f.fake.provider.create = create
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const replacement = f.fake.calls.filter((call) => call.action === "create").at(-1)?.input as VmCreateOptions
  expect(replacement.volumes).toContainEqual(mount)
})

test("failed legacy migration preserves the original container and its metadata", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const original = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
  f.fake.configs.set(original.name, { ...original, image: "touri-bot:1", volumes: [] })
  f.fake.provider.migrateWorkspace = async () => ({
    success: false,
    errorCode: "SNAPSHOT_FAILED",
    error: "backup failed",
  })
  const offset = f.fake.calls.length
  await expect(f.vm.service.acquire({ botId: bot.id })).rejects.toThrow("backup failed")
  expect(f.fake.calls.slice(offset).some((call) => ["destroy", "deleteVolume"].includes(call.action))).toBe(false)
  expect(f.fake.configs.get(original.name)?.image).toBe("touri-bot:1")
})

test.each([false, true])("image upgrade stops the builder even when migration fails (%s)", async (fails) => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const original = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
  f.fake.configs.set(original.name, { ...original, image: "touri-bot:1", volumes: [] })
  let stops = 0
  f.fake.provider.stopBuilder = async () => {
    stops++
  }
  if (fails)
    f.fake.provider.migrateWorkspace = async () => ({
      success: false,
      errorCode: "COMMAND_FAILED",
      error: "migration failed",
    })
  const acquisition = f.vm.service.acquire({ botId: bot.id })
  if (fails) await expect(acquisition).rejects.toThrow("migration failed")
  else await (await acquisition)()
  expect(stops).toBe(1)
})

test("orphan sweep protects persisted workspace volumes even before a replacement bot exists", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const db = f.runtime.kernel.db as Database
  const volume = "touri-migrate-retained-data"
  db.query("UPDATE bot_machines SET volume = ? WHERE bot_id = ?").run(
    JSON.stringify([{ type: "volume", source: volume, target: "/workspace" }]),
    bot.id,
  )
  let protectedVolumes: string[] = []
  f.fake.provider.sweepOrphans = async (input) => {
    protectedVolumes = input.protectedVolumes
  }
  await f.vm.sweepOrphans()
  expect(protectedVolumes).toEqual([volume])
})

test("orphan sweep includes machine rows inserted after its first batch", async () => {
  const f = await fixture()
  const db = f.runtime.kernel.db as Database
  const saveBot = db.query(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES (?,?,'codex',?,1,1)`)
  const saveMachine = db.query("INSERT INTO bot_machines(bot_id,vm_id,volume) VALUES (?,?,?)")
  Array.from({ length: 51 }, (_, index) => index).forEach((index) => {
    const botId = `sweep-${index}`
    saveBot.run(botId, `Synthetic ${index}`, join(f.root, botId))
    saveMachine.run(botId, `machine-${index}`, `volume-${index}`)
  })
  let protectedVolumes: string[] = []
  f.fake.provider.sweepOrphans = async (input) => {
    protectedVolumes = input.protectedVolumes
  }
  const sweep = f.vm.sweepOrphans()
  const inserted = new Promise<void>((resolve) => {
    setImmediate(() => {
      saveBot.run("sweep-late", "Synthetic late", join(f.root, "sweep-late"))
      saveMachine.run("sweep-late", "machine-late", "volume-late")
      resolve()
    })
  })

  await inserted
  await sweep

  expect(protectedVolumes).toContain("volume-late")
})

test("provider credentials require opt-in, stage privately, redact and revoke after run", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const first = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "thread",
    token: "token",
  })
  const creation = f.fake.calls.find((call) => call.action === "create")?.input as {
    volumes: Array<{ source: string; target: string; readOnly?: boolean }>
  }
  const auth = creation.volumes.find((volume) => volume.target === "/run/touri-auth")
  expect(auth).toBeUndefined()
  expect(f.fake.files.has("/workspace/.home/.codex/auth.json")).toBe(false)
  expect(creation.volumes.some((volume) => volume.source.endsWith("host-home"))).toBe(false)
  await first.release()
  await f.request(`/bots/${bot.id}`, { vmProviderLogin: true }, "PATCH")
  const opted = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "thread",
    token: "token",
  })
  expect(f.fake.files.get("/workspace/.home/.codex/auth.json")).toContain("only-provider-secret")
  expect(auth).toBeUndefined()
  expect(opted.env).toMatchObject({ HOME: "/workspace/.home", CODEX_HOME: "/workspace/.home/.codex" })
  expect(
    f.fake.calls.some(
      (call) =>
        call.action === "exec" && JSON.stringify(call.input).includes('"-r","/workspace/.home/.codex/auth.json"'),
    ),
  ).toBe(true)
  expect(f.runtime.kernel.redact("only-provider-secret")).not.toContain("only-provider-secret")
  expect(f.fake.files.has("/workspace/.home/decoy-secret")).toBe(false)
  await opted.release()
  expect(f.fake.files.has("/workspace/.home/.codex/auth.json")).toBe(false)
  const db = f.runtime.kernel.db as Database
  expect(JSON.stringify(db.query("SELECT * FROM bot_machines").all())).not.toContain("only-provider-secret")
  const log = readFileSync(join(f.runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")
  expect(log).toContain('"stage":"auth"')
  expect(log).not.toContain("only-provider-secret")
})

test("host Codex file provisioning skips an unanswered Keychain RPC; toggle OFF never reads host auth", async () => {
  const f = await fixture()
  let hostCalls = 0
  f.runtime.kernel.callHost = () => {
    hostCalls++
    return new Promise(() => {})
  }
  const bot = await f.bot()
  const off = await f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" })
  expect(hostCalls).toBe(0)
  expect(
    f.fake.calls.some(
      (call) => call.action === "exec" && JSON.stringify(call.input).includes("/run/touri-auth/codex.json"),
    ),
  ).toBe(false)
  await off.release()
  await f.request(`/bots/${bot.id}`, { vmProviderLogin: true }, "PATCH")
  const on = await f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" })
  expect(hostCalls).toBe(0)
  await on.release()
})

const enqueueVmTurn = (f: Awaited<ReturnType<typeof fixture>>, bot: Bot) => {
  const store = f.runtime.kernel.services.use("store.api")
  if (!store || !bot.mainThreadId) throw new Error("Missing store/thread")
  const inserted = store.insertMessage({
    message: {
      id: f.runtime.kernel.newId(),
      threadId: bot.mainThreadId,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Use o seu navegador para abrir https://touri.ai",
      parts: [],
      sender: null,
      source: "local",
    },
  })
  if (!inserted.success) throw new Error(inserted.error)
  const engine = createRuntimeEngine({ kernel: f.runtime.kernel })
  const result = engine.enqueue({ threadId: bot.mainThreadId, requestMessageId: inserted.message.id, trigger: "user" })
  if (!result.success) throw new Error(result.error)
  return { engine, run: result.run, store }
}

test("VM engine resumes the turn once when the bot computer stops mid-turn", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const threadId = bot.mainThreadId ?? ""
  const store = f.runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const scenario = join(f.root, "scenario.json")
  const requests = join(f.root, "requests.jsonl")
  writeFileSync(
    scenario,
    JSON.stringify({
      requestLogPath: requests,
      events: [{ type: "delta", delta: "parcial\n" }, { type: "sleep" }],
      slowMs: 1000,
    }),
  )
  const spawn = f.fake.provider.spawn
  const guests: Array<{ kill: (signal: "SIGKILL") => void; exited: Promise<unknown> }> = []
  f.fake.provider.spawn = (input) => {
    if (input.command !== "codex") return spawn(input)
    const child = f.runtime.kernel.spawnTree({
      cmd: process.execPath,
      args: ["run", join(import.meta.dir, "../fakes/fake-codex.ts"), ...(input.args ?? [])],
      cwd: f.root,
      env: { ...process.env, TOURI_FAKE_SCENARIO: scenario },
    })
    if (child.success) guests.push(child)
    return child
  }
  const engine = createRuntimeEngine({ kernel: f.runtime.kernel, resumeBackoffMs: 20 })
  try {
    const request = store.insertMessage({
      message: {
        id: f.runtime.kernel.newId(),
        threadId,
        parentId: store.getThread({ threadId })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Gere o relatório",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const started = engine.enqueue({ threadId, requestMessageId: request.message.id, trigger: "user" })
    if (!started.success) throw new Error(started.error)
    for (let i = 0; i < 400 && !store.activePath({ threadId }).some((message) => message.text === "parcial\n"); i++)
      await Bun.sleep(5)
    writeFileSync(scenario, JSON.stringify({ requestLogPath: requests, deltas: ["retomado\n"] }))
    // The container stops outside touri (host sleep, crash, OOM): its processes die without a result.
    const startsBefore = f.fake.calls.filter((call) => call.action === "start").length
    for (const id of f.fake.machines.keys()) f.fake.machines.set(id, "stopped")
    for (const guest of guests) guest.kill("SIGKILL")
    await waitForTerminal(started.run)
    expect(started.run.status).toBe("failed")
    let runs = engine.listRuns(threadId)
    for (let i = 0; i < 400 && !(runs.length === 2 && runs[0]?.status === "succeeded"); i++) {
      await Bun.sleep(10)
      runs = engine.listRuns(threadId)
    }
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "failed"])
    expect(f.fake.calls.filter((call) => call.action === "start").length).toBeGreaterThan(startsBefore)
    expect(
      (f.runtime.kernel.db as Database).query("SELECT previous_run_id, reason FROM run_continuations").all(),
    ).toEqual([{ previous_run_id: started.run.id, reason: "provider_crash" }])
    expect(store.activePath({ threadId }).map((message) => message.text)).toEqual([
      "Gere o relatório",
      "parcial\n",
      "Retomado após falha do provedor",
      "retomado\n",
    ])
    const sessions = readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method)
      .filter((method) => method === "thread/start" || method === "thread/resume")
    expect(sessions).toEqual(["thread/start", "thread/resume"])
  } finally {
    await engine.shutdown()
    await Promise.all(guests.map((guest) => guest.exited))
  }
})

const waitForTerminal = async (run: { status: string }) => {
  const deadline = Date.now() + 10_000
  while (!["failed", "canceled", "succeeded"].includes(run.status) && Date.now() < deadline) await Bun.sleep(10)
  expect(["failed", "canceled", "succeeded"]).toContain(run.status)
}

test.each(["status", "image", "start", "ready"])(
  "a transient service failure during %s keeps the message pending and sends it once ready",
  async (stage) => {
    const f = await fixture(true, { service: 2_000 })
    const bot = await f.bot()
    let serviceReady = false
    let startRequests = 0
    const status = f.fake.provider.status
    const unavailable = () => ({
      success: false as const,
      errorCode: "MACHINE_SERVICE_UNAVAILABLE" as const,
      error: "XPC connection invalid",
    })
    let hitStage = stage === "status"
    f.fake.provider.status = (input) => (hitStage && !serviceReady ? Promise.resolve(unavailable()) : status(input))
    f.fake.provider.startService = async () => {
      startRequests++
      return { success: false, errorCode: "MACHINE_SERVICE_START_FAILED", error: "Service still starting" }
    }
    const image = f.fake.provider.ensureImage
    const start = f.fake.provider.start
    const exec = f.fake.provider.exec
    if (stage === "image")
      f.fake.provider.ensureImage = async (input) => {
        hitStage = true
        if (!serviceReady) throw new MachineServiceError("MACHINE_SERVICE_UNAVAILABLE", "XPC connection invalid")
        return image(input)
      }
    if (stage === "start")
      f.fake.provider.start = (input) => {
        hitStage = true
        return serviceReady ? start(input) : Promise.resolve(unavailable())
      }
    if (stage === "ready")
      f.fake.provider.exec = (input) => {
        if (input.args?.includes(GUEST_READY_COMMAND)) {
          hitStage = true
          if (!serviceReady) return Promise.resolve(unavailable())
        }
        return exec(input)
      }
    const states: Array<string> = []
    const publish = f.runtime.kernel.publish
    f.runtime.kernel.publish = (event) => {
      if (event.type === "machine.updated") states.push(event.machine.status)
      publish(event)
    }
    const scenario = join(f.root, "scenario.json")
    // Terminate the fixture so a random transient-secret prefix cannot mask its last byte.
    writeFileSync(scenario, JSON.stringify({ deltas: ["Pronto\n"] }))
    const spawn = f.fake.provider.spawn
    const guests: Array<Promise<unknown>> = []
    let providerStarts = 0
    f.fake.provider.spawn = (input) => {
      if (input.command !== "codex") return spawn(input)
      providerStarts++
      const child = f.runtime.kernel.spawnTree({
        cmd: process.execPath,
        args: ["run", join(import.meta.dir, "../fakes/fake-codex.ts"), ...(input.args ?? [])],
        cwd: f.root,
        env: { ...process.env, TOURI_FAKE_SCENARIO: scenario },
      })
      if (child.success) guests.push(child.exited)
      return child
    }
    const { engine, run, store } = enqueueVmTurn(f, bot)
    try {
      for (let i = 0; i < 100 && startRequests === 0; i++) await Bun.sleep(5)
      expect(startRequests).toBe(1)
      expect(run.status).toBe("starting")
      expect(providerStarts).toBe(0)
      expect(f.vm.service.states()[0]).toMatchObject({ status: "starting", error: null, errorCode: null })
      expect(store.activePath({ threadId: run.threadId }).some((message) => message.status === "failed")).toBe(false)
      serviceReady = true
      await waitForTerminal(run)
      expect(run.status).toBe("succeeded")
      expect(providerStarts).toBe(1)
      expect(startRequests).toBe(1)
      expect(engine.listRuns(run.threadId)).toHaveLength(1)
      expect(f.vm.service.states()[0]).toMatchObject({ status: "running", error: null, errorCode: null })
      expect(states).not.toContain("error")
      expect(store.activePath({ threadId: run.threadId }).at(-1)?.text).toBe("Pronto\n")
    } finally {
      await engine.shutdown()
      await Promise.all(guests)
    }
  },
)

test.each([false, true])("service timeout reaches the turn as E8001 with prewarming=%s", async (prewarm) => {
  const f = await fixture(true, { service: 200 })
  const bot = await f.bot()
  let startRequests = 0
  f.fake.provider.startService = async () => {
    startRequests++
    return { success: true }
  }
  f.fake.provider.status = async () => ({
    success: false,
    errorCode: "MACHINE_SERVICE_UNAVAILABLE",
    error: "private XPC connection error: Connection invalid",
  })
  const warming = prewarm ? f.vm.service.intent({ botId: bot.id, intent: "composer-focus" }).catch(() => {}) : null
  const { engine, run, store } = enqueueVmTurn(f, bot)
  try {
    await Bun.sleep(30)
    expect(run.status).toBe("starting")
    expect(f.vm.service.states()[0]).toMatchObject({ status: "starting", error: null })
    await waitForTerminal(run)
    expect(startRequests).toBe(1)
    expect(run).toMatchObject({ status: "failed", errorClass: "machine_service_unavailable" })
    const reader = createRuntimePersistence({ database: f.runtime.kernel.db })
    expect(reader.getRun(run.id)).toEqual(run)
    expect(engine.listRuns(run.threadId)).toEqual([run])
    expect(engine.activeRun({ threadId: run.threadId })).toBeNull()
    const reply = store.activePath({ threadId: run.threadId }).find((message) => message.id === run.replyMessageId)
    expect(reply).toMatchObject({ status: "failed", runId: run.id })
    expect(store.getThread({ threadId: run.threadId })?.carryoverNote).toContain("machine_service_unavailable")
    const notice = store
      .activePath({ threadId: run.threadId })
      .flatMap((message) => message.parts)
      .find((part) => part.type === "notice")
    if (notice?.type !== "notice") throw new Error("Missing failure notice")
    expect(notice.text).toContain("[TOURI-E8001]")
    expect(notice.text).toContain("TOURI-E8001")
    expect(f.vm.service.states()[0]).toMatchObject({ status: "error", errorCode: "TOURI-E8001" })
    expect(f.fake.calls.some((call) => call.action === "image" || call.action === "spawn")).toBe(false)
    await engine.shutdown()
    const reopened = createRuntimeEngine({ kernel: f.runtime.kernel })
    try {
      expect(reopened.listRuns(run.threadId)).toEqual([run])
      expect(store.activePath({ threadId: run.threadId }).find((message) => message.id === reply?.id)).toEqual(reply)
      expect(reader.saveRun({ ...run, status: "succeeded", errorClass: null, errorMessage: null })).toBe(false)
      expect(reopened.listRuns(run.threadId)).toEqual([run])
    } finally {
      await reopened.shutdown()
    }
  } finally {
    await engine.shutdown()
    await warming
  }
})

test("service action publishes progress, retries the machine and returns safe failures", async () => {
  const f = await fixture()
  const bot = await f.bot()
  f.runtime.kernel.registerRoutes({ name: "machine-test", routes: machineActionRoutes(f.runtime.kernel, f.vm.service) })
  let attempts = 0
  let requests = 0
  const startService = f.vm.service.startService
  f.vm.service.startService = (input) => {
    requests++
    return startService(input)
  }
  const ready = deferred()
  f.fake.provider.startService = async () => {
    attempts++
    await ready.promise
    return { success: true }
  }
  const first = f.request("/machines/service/start", { botId: bot.id })
  const second = f.request("/machines/service/start", { botId: bot.id })
  for (let i = 0; i < 100 && requests < 2; i++) await Bun.sleep(1)
  expect(requests).toBe(2)
  expect(f.vm.service.states()[0]).toMatchObject({ status: "starting", progress: "Iniciando serviço de máquinas…" })
  ready.resolve()
  expect((await first).status).toBe(200)
  expect((await second).status).toBe(200)
  expect(attempts).toBe(1)
  expect(f.fake.calls.filter((call) => call.action === "start")).toHaveLength(1)
  f.fake.provider.startService = async () => ({
    success: false,
    errorCode: "MACHINE_SERVICE_START_FAILED",
    error: "private XPC failure",
  })
  const failed = await f.request("/machines/service/start", { botId: bot.id })
  expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({ code: "TOURI-E8002", domain: "machine" })
  expect(f.vm.service.states()[0]).toMatchObject({
    status: "error",
    errorCode: "TOURI-E8002",
    error: expect.not.stringContaining("private"),
  })
})

test("explicit machine stop cancels independent prewarming and late preparation cannot restore the header", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const blocked = deferred()
  let entered = false
  f.fake.provider.ensureImage = async () => {
    entered = true
    await blocked.promise
  }
  const warming = f.vm.service.intent({ botId: bot.id, intent: "composer-focus" }).catch(() => {})
  for (let i = 0; i < 100 && !entered; i++) await Bun.sleep(1)
  f.runtime.kernel.registerRoutes({ name: "machine-test", routes: machineActionRoutes(f.runtime.kernel, f.vm.service) })
  expect((await f.request(`/bots/${bot.id}/machine/stop`)).status).toBe(200)
  await warming
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", progress: null, error: null })
  blocked.resolve()
  await Bun.sleep(5)
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", progress: null, error: null })
  expect(f.fake.calls.some((call) => call.action === "start")).toBe(false)
})

test("confirmed machine restart cancels every active and queued bot turn before restarting", async () => {
  const f = await fixture(true)
  const bot = await f.bot({ vmProviderLogin: true })
  let entered = false
  let imageAttempts = 0
  f.fake.provider.ensureImage = () => {
    if (++imageAttempts > 1) return Promise.resolve()
    entered = true
    return new Promise(() => {})
  }
  const { engine, run, store } = enqueueVmTurn(f, bot)
  const queued = engine.enqueue({
    threadId: run.threadId,
    requestMessageId: run.requestMessageId ?? "",
    trigger: "user",
  })
  if (!queued.success) throw new Error(queued.error)
  f.runtime.kernel.services.provide("runtime.cancelBotTurns", engine.cancelBotTurns)
  f.runtime.kernel.registerRoutes({ name: "machine-test", routes: machineActionRoutes(f.runtime.kernel, f.vm.service) })
  try {
    for (let attempt = 0; attempt < 200 && !entered; attempt++) await Bun.sleep(5)
    const response = await f.request(`/bots/${bot.id}/machine/restart`, { stopTurns: true })
    expect(response.status).toBe(200)
    expect(run.status).toBe("canceled")
    expect(queued.run.status).toBe("canceled")
    expect(store.activePath({ threadId: run.threadId }).at(-1)?.status).toBe("canceled")
    expect(((await response.json()) as { machine: { status: string } }).machine.status).toBe("running")
  } finally {
    await engine.shutdown()
  }
})

test("unanswered readiness probe times out into a run error event and a pt-BR chat notice without spawning CLI", async () => {
  const f = await fixture(true, { ready: 40 })
  const bot = await f.bot({ vmProviderLogin: true })
  const exec = f.fake.provider.exec
  f.fake.provider.exec = (input) => (input.args?.includes(GUEST_READY_COMMAND) ? new Promise(() => {}) : exec(input))
  const events: Array<import("@touri/contracts").UiEvent> = []
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => events.push(event))
  const { engine, run, store } = enqueueVmTurn(f, bot)
  try {
    await waitForTerminal(run)
    expect(run).toMatchObject({ status: "failed", errorClass: "timeout" })
    expect(events.some((event) => event.type === "run.updated" && event.run.errorClass === "timeout")).toBe(true)
    const notice = store
      .activePath({ threadId: bot.mainThreadId ?? "" })
      .flatMap((message) => message.parts)
      .find((part) => part.type === "notice")
    expect(notice).toMatchObject({
      type: "notice",
      code: "run_failed",
      level: "error",
      failure: {
        stage: "machine_boot",
        detail: "A máquina não ficou pronta em 0.04 s: o ambiente gráfico não iniciou ou a máquina não respondeu",
      },
    })
    expect(notice && "text" in notice && notice.text).toContain("A máquina não ficou pronta")
    expect(notice && "text" in notice && notice.text).toContain("TOURI-E1008")
    expect(run.errorMessage).toContain("A máquina não ficou pronta")
    expect(run.errorMessage).toContain("Xvfb não iniciou")
    expect(f.fake.calls.some((call) => call.action === "spawn")).toBe(false)
  } finally {
    unsubscribe()
    await engine.shutdown()
  }
})

test.each(["boot", "ready", "auth", "exec", "instructions", "forward-port"] as const)(
  "Stop finishes the chat turn while VM %s is stalled",
  async (stage) => {
    const f = await fixture(true, { boot: 10_000, ready: 10_000, auth: 10_000, exec: 10_000 })
    const bot = await f.bot({ vmProviderLogin: true })
    if (stage === "auth")
      (f.runtime.kernel.db as Database)
        .query("DELETE FROM settings WHERE key = ?")
        .run(`vm-login-source:${bot.id}:codex`)
    let entered = false
    if (stage === "forward-port")
      f.fake.provider.forwardPort = () => {
        entered = true
        return new Promise(() => {})
      }
    if (stage === "boot")
      f.fake.provider.ensureImage = () => {
        entered = true
        return new Promise(() => {})
      }
    if (stage === "auth") {
      rmSync(join(f.root, "host-home/.codex/auth.json"))
      f.runtime.kernel.callHost = () => {
        entered = true
        return new Promise(() => {})
      }
    }
    const exec = f.fake.provider.exec
    const ensureImage = f.fake.provider.ensureImage
    if (stage === "ready")
      f.fake.provider.exec = (input) => {
        if (input.args?.includes(GUEST_READY_COMMAND)) {
          entered = true
          return new Promise(() => {})
        }
        return exec(input)
      }
    const spawn = f.fake.provider.spawn
    let instructionSignal: AbortSignal | undefined
    if (stage === "instructions")
      f.fake.provider.exec = (input) => {
        if (input.command === "head") {
          entered = true
          instructionSignal = input.signal
          return new Promise(() => {})
        }
        return exec(input)
      }
    if (stage === "exec")
      f.fake.provider.spawn = (input) => {
        const child = spawn(input)
        if (!child.success) return child
        entered = true
        return { ...child, stdin: new WritableStream({ write: () => new Promise(() => {}) }) }
      }
    const { engine, run } = enqueueVmTurn(f, bot)
    try {
      for (let attempt = 0; attempt < 200 && !entered; attempt++) await Bun.sleep(5)
      expect(entered).toBe(true)
      engine.cancel(run.id)
      await waitForTerminal(run)
      expect(run.status).toBe("canceled")
      expect(
        f.runtime.kernel.services
          .use("store.api")
          ?.activePath({ threadId: bot.mainThreadId ?? "" })
          .at(-1)?.status,
      ).toBe("canceled")
      if (stage === "instructions") expect(instructionSignal?.aborted).toBe(true)
      expect(
        f.fake.calls.some(
          (call) => call.action === "spawn" && JSON.stringify(call.input).includes('"command":"codex"'),
        ),
      ).toBe(false)
      // A canceled operation must not hold the per-bot queue forever.
      f.fake.provider.exec = exec
      f.fake.provider.spawn = spawn
      if (stage === "boot") f.fake.provider.ensureImage = async () => {}
      else f.fake.provider.ensureImage = ensureImage
      const release = await f.vm.service.acquire({ botId: bot.id })
      await release()
      await f.vm.service.restart({ botId: bot.id })
    } finally {
      await engine.shutdown()
    }
  },
)

test("vault timeout revokes staging and a late host response cannot provision credentials", async () => {
  const f = await fixture(true, { auth: 40 })
  const bot = await f.bot({ vmProviderLogin: true })
  ;(f.runtime.kernel.db as Database).query("DELETE FROM settings WHERE key = ?").run(`vm-login-source:${bot.id}:codex`)
  rmSync(join(f.root, "host-home/.codex/auth.json"))
  let reply: (result: unknown) => void = () => {}
  f.runtime.kernel.callHost = (() =>
    new Promise<unknown>((resolve) => {
      reply = resolve
    })) as Kernel["callHost"]
  await expect(
    f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" }),
  ).rejects.toThrow("O cofre de segredos não respondeu")
  reply({ success: true, value: { value: JSON.stringify({ access_token: "late-secret" }) } })
  await Bun.sleep(10)
  const creation = f.fake.calls.find((call) => call.action === "create")?.input as {
    volumes: Array<{ source: string; target: string }>
  }
  expect(creation.volumes.some((volume) => volume.target === "/run/touri-auth")).toBe(false)
  expect(f.fake.files.has("/workspace/.home/.codex/auth.json")).toBe(false)
  expect(
    f.fake.calls.some((call) => call.action === "spawn" && JSON.stringify(call.input).includes('"command":"codex"')),
  ).toBe(false)
})

test.each(["timeout", "stop", "output"] as const)(
  "VM first output: %s is bounded, logged, and cancels its CLI",
  async (mode) => {
    const f = await fixture()
    const bot = await f.bot({ vmProviderLogin: true })
    const controller = new AbortController()
    const prepared = await f.vm.service.prepareTurn({
      botId: bot.id,
      threadId: bot.mainThreadId ?? "thread",
      token: "mcp",
      signal: controller.signal,
    })
    const thread = f.runtime.kernel.services.use("store.api")?.getThread({ threadId: bot.mainThreadId ?? "" })
    if (!thread) throw new Error("Missing thread")
    let kills = 0
    const args: StartTurnArgs = {
      ...prepared,
      thread,
      session: null,
      fingerprint: sessionFingerprint({
        bot: prepared.bot,
        cwd: prepared.cwd,
        mcpCommand: prepared.mcp.command,
        mcpArgs: prepared.mcp.args,
      }).fingerprint,
      input: [{ type: "text", text: "hello" }],
      developerInstructions: "",
      handoffPacket: null,
      signal: controller.signal,
      onEvent: () => {},
      execution: {
        ...prepared.execution,
        spawn: (input) => {
          const child = prepared.execution.spawn(input)
          return child.success
            ? {
                ...child,
                kill: (signal) => {
                  kills++
                  child.kill(signal)
                },
              }
            : child
        },
      },
    }
    const provider: ProviderAdapter = {
      provider: "codex",
      detect: async () => ({ success: false, errorCode: "cli_missing", error: "unused" }),
      answerApproval: async () => ({ success: true }),
      shutdown: async () => {},
      startTurn: async (args) => {
        args.execution?.spawn({ cmd: "codex", args: [], cwd: "/workspace", env: {} })
        args.onEvent({ type: "turn_started", externalTurnId: "silent" })
        if (mode !== "output") return new Promise(() => {})
        args.onEvent({ type: "text_delta", itemId: "a", delta: "hello" })
        await Bun.sleep(70)
        return { success: true, externalSessionId: "guest", rolloutPath: null, status: "succeeded" }
      },
    }
    try {
      const result = startVmTurn({ kernel: f.runtime.kernel, provider, args, firstOutputMs: 40, turnMs: 500 })
      if (mode === "stop") {
        await Bun.sleep(5)
        controller.abort()
      }
      if (mode === "output") expect((await result).success).toBe(true)
      else {
        await expect(result).rejects.toThrow(mode === "stop" ? "Turno cancelado" : "não produziu saída")
        expect(kills).toBeGreaterThan(0)
      }
      expect(readFileSync(join(f.runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")).toContain(
        '"stage":"first-output"',
      )
    } finally {
      await prepared.release()
    }
  },
)

test("P1-3 Claude OAuth token is secret-store scoped and injected only into its opted-in VM turn", async () => {
  const f = await fixture()
  const claude = await f.bot({ provider: "claude", vmProviderLogin: true })
  const other = await f.bot({ provider: "claude", vmProviderLogin: true })
  const tokens = new Map([[providerLoginAccount(claude.id, "claude"), "only-this-bot-oauth-token"]])
  const original = f.runtime.kernel.callHost
  f.runtime.kernel.callHost = (async (method: string, params: { account: string }) =>
    method === "keychain.get"
      ? {
          success: true,
          value: {
            value: tokens.get(params.account) ?? null,
          },
        }
      : original(method as "keychain.get", params)) as Kernel["callHost"]
  const turn = await f.vm.service.prepareTurn({
    botId: claude.id,
    threadId: claude.mainThreadId ?? "thread",
    token: "mcp",
  })
  expect(turn.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("only-this-bot-oauth-token")
  expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("only-this-bot-oauth-token")
  expect(f.runtime.kernel.redact("only-this-bot-oauth-token")).not.toContain("only-this-bot-oauth-token")
  expect(JSON.stringify((f.runtime.kernel.db as Database).query("SELECT * FROM bot_machines").all())).not.toContain(
    "only-this-bot-oauth-token",
  )
  expect(
    f.fake.calls
      .filter((call) => call.action === "exec")
      .some((call) => JSON.stringify(call.input).includes("/run/touri-auth/claude.json")),
  ).toBe(false)
  await turn.release()
  await expect(
    f.vm.service.prepareTurn({ botId: other.id, threadId: other.mainThreadId ?? "other", token: "mcp" }),
  ).rejects.toBeInstanceOf(ProviderLoginError)
  expect(f.vm.service.states().find((state) => state.botId === other.id)?.error).toContain("claude setup-token")
  tokens.set(providerLoginAccount(other.id, "claude"), "other-bot-token")
  const recovered = await f.vm.service.prepareTurn({
    botId: other.id,
    threadId: other.mainThreadId ?? "other",
    token: "mcp",
  })
  expect(recovered.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("other-bot-token")
  expect(f.vm.service.states().find((state) => state.botId === other.id)?.error).toBeNull()
  await recovered.release()
})

test("P1-3 missing Codex login has a recoverable authentication error instead of a Claude Keychain error", async () => {
  const f = await fixture()
  const bot = await f.bot({ provider: "codex", vmProviderLogin: true })
  const hostHome = join(f.root, "host-home")
  rmSync(join(hostHome, ".codex/auth.json"))
  await expect(readProviderLogin(f.runtime.kernel, bot, hostHome)).rejects.toThrow("codex login --device-auth")
  await expect(
    f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" }),
  ).rejects.toBeInstanceOf(ProviderLoginError)
  const error = f.vm.service.states()[0]?.error ?? ""
  expect(error).toContain("Arquivo de login do Codex indisponível")
  expect(error).not.toContain("Keychain")
})

test("explicit Claude host file handoff does not consult the vault or leak credentials", async () => {
  const f = await fixture(true, { auth: 200 })
  const bot = await f.bot({ provider: "claude", vmProviderLogin: true })
  mkdirSync(join(f.root, "host-home/.claude"))
  writeFileSync(
    join(f.root, "host-home/.claude/.credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "claude-file-secret" } }),
  )
  ;(f.runtime.kernel.db as Database)
    .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES (?,?,?)")
    .run(`vm-login-source:${bot.id}:claude`, '"host-file"', Date.now())
  f.runtime.kernel.callHost = (() => new Promise(() => {})) as Kernel["callHost"]
  const turn = await f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" })
  const creation = f.fake.configs.values().next().value as VmCreateOptions
  const auth = creation.volumes?.find((volume) => volume.target === "/run/touri-auth")
  expect(auth).toBeUndefined()
  expect(f.fake.files.get("/workspace/.home/.claude/.credentials.json")).toContain("claude-file-secret")
  expect(f.runtime.kernel.redact("claude-file-secret")).not.toContain("claude-file-secret")
  await turn.release()
  expect(f.fake.files.has("/workspace/.home/.claude/.credentials.json")).toBe(false)
})

test("Claude unanswered credential handoff returns an actionable login error and can retry", async () => {
  const f = await fixture(true, { auth: 40 })
  const bot = await f.bot({ provider: "claude", vmProviderLogin: true })
  f.runtime.kernel.callHost = (() => new Promise(() => {})) as Kernel["callHost"]
  await expect(
    f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" }),
  ).rejects.toThrow("O cofre de segredos não respondeu. Tente novamente.")
  expect(f.vm.service.states()[0]?.errorCode).toBe("TOURI-E3001")
  f.runtime.kernel.callHost = (async () => ({
    success: true,
    value: { value: "retry-oauth-secret" },
  })) as Kernel["callHost"]
  const turn = await f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" })
  expect(turn.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("retry-oauth-secret")
  await turn.release()
})

test("Claude unreadable credential mount explains recovery and revokes the staged file", async () => {
  const f = await fixture()
  const bot = await f.bot({ provider: "claude", vmProviderLogin: true })
  mkdirSync(join(f.root, "host-home/.claude"))
  writeFileSync(
    join(f.root, "host-home/.claude/.credentials.json"),
    JSON.stringify({ access_token: "unreadable-claude-secret" }),
  )
  ;(f.runtime.kernel.db as Database)
    .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES (?,?,?)")
    .run(`vm-login-source:${bot.id}:claude`, '"host-file"', Date.now())
  f.runtime.kernel.callHost = (async () => ({ success: true, value: { value: null } })) as Kernel["callHost"]
  const exec = f.fake.provider.exec
  f.fake.provider.exec = (input) =>
    input.command === "test" && input.args?.includes("/workspace/.home/.claude/.credentials.json")
      ? Promise.resolve({ success: false, errorCode: "COMMAND_FAILED", error: "private mount diagnostic" })
      : exec(input)
  await expect(
    f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "mcp" }),
  ).rejects.toThrow("reconecte o provedor nas permissões")
  const creation = f.fake.configs.values().next().value as VmCreateOptions
  expect(creation.volumes?.some((volume) => volume.target === "/run/touri-auth")).toBe(false)
  expect(f.fake.files.has("/workspace/.home/.claude/.credentials.json")).toBe(false)
  expect(f.vm.service.states()[0]?.error).not.toContain("private mount diagnostic")
})

test("Linux host rejects VM bot with the unavailable reason; local stays default", async () => {
  const f = await fixture(false)
  const rejected = await f.request("/bots", { name: "Linux", provider: "codex", machine: "vm" })
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ code: "TOURI-E8000", domain: "machine", retryable: false })
  const local = await f.request("/bots", { name: "Local", provider: "codex" })
  expect(((await local.json()) as { bot: Bot }).bot.machine).toBe("local")
})

test("failed startup shows error; busy reset is rejected; forwarding returns loopback Preview URL", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const release = await f.vm.service.acquire({ botId: bot.id })
  await expect(f.vm.service.restart({ botId: bot.id, reset: true })).rejects.toThrow("ocupada")
  expect(await f.vm.service.forwardPort({ botId: bot.id, guestPort: 3000 })).toEqual({
    hostPort: 49123,
    url: "http://127.0.0.1:49123",
  })
  await release()
  f.fake.failStart()
  await expect(f.vm.service.restart({ botId: bot.id })).rejects.toThrow("start failed")
  expect(f.vm.service.states()[0]?.status).toBe("error")
})

test("VM computer tools route exclusively to guest service; host routing needs its separate opt-in", async () => {
  const f = await fixture()
  const bot = await f.bot({ computerUse: true })
  const tools: Array<ToolRegistration> = []
  let hostCalls = 0
  let guestCalls = 0
  const kernel: Kernel = {
    ...f.runtime.kernel,
    registerTools: ({ tools: registrations }) => {
      tools.push(...registrations)
      return { success: true, count: registrations.length }
    },
    callHost: async () => {
      hostCalls++
      return { success: false, errorCode: "HOST_UNAVAILABLE", error: "host forbidden" }
    },
  }
  kernel.services.provide("vm.runtime", {
    ...f.vm.service,
    computer: async () => {
      guestCalls++
      return { success: true, content: [{ type: "text", text: "fake guest display" }] }
    },
  } satisfies VmRuntime)
  await initComputer(kernel)
  const tool = tools.find((tool) => tool.name === "computer_screenshot")
  if (!tool) throw new Error("Missing computer tool")
  let approvalId: string | undefined
  const bridge = createApprovalBridge({
    kernel,
    onCard: (_, part) => {
      approvalId = part.approvalId
      return true
    },
  })
  kernel.services.provide("approvals.present", bridge.present)
  const pending = tool.handler({
    args: {},
    ctx: {
      botId: bot.id,
      threadId: bot.mainThreadId ?? "",
      runId: null,
      projectId: null,
      cwd: "/workspace",
      signal: new AbortController().signal,
    },
  })
  expect(guestCalls).toBe(0)
  if (!approvalId) throw new Error("Missing guest approval")
  await bridge.approve({ approvalId, decision: "approved" })
  expect((await pending).success).toBe(true)
  bridge.dispose()
  expect(guestCalls).toBe(1)
  expect(hostCalls).toBe(0)
})

test("VM process detection forwards the guest port and publishes the localhost Preview", async () => {
  const f = await fixture()
  const store = createProjectStore({ kernel: f.runtime.kernel })
  const projectPath = join(f.root, "project")
  mkdirSync(projectPath)
  const created = store.createProject({
    id: "project",
    name: "Guest app",
    path: projectPath,
    gitRemote: null,
    defaultBranch: null,
    dataDir: join(f.runtime.kernel.paths.projectsDir, "project"),
    now: Date.now(),
  })
  if (!created.success) throw new Error(created.error)
  const bot = await f.bot({ projectId: created.project.id })
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("guest") })
  const port = reservation.port
  reservation.stop(true)
  if (!port) throw new Error("No port")
  const events: Array<import("@touri/contracts").UiEvent> = []
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => events.push(event))
  let guestSpawns = 0
  f.runtime.kernel.services.provide("vm.runtime", {
    ...f.vm.service,
    acquire: async () => async () => {},
    spawn: (input) => {
      guestSpawns++
      expect(input.cwd).toBe("/workspace")
      return f.runtime.kernel.spawnTree({
        cmd: process.execPath,
        args: [
          "-e",
          `Bun.serve({port:${port}, fetch:()=>new Response('guest')}); console.log('http://localhost:3000')`,
        ],
        cwd: projectPath,
        env: { PATH: process.env.PATH ?? "" },
      })
    },
    exec: async ({ command }) => ({
      success: true,
      code: 0,
      stderr: "",
      stdout:
        command === "cat"
          ? "123"
          : command === "ps"
            ? "123 123\n124 123"
            : 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=124,fd=18))',
    }),
    forwardPort: async ({ guestPort }) => {
      expect(guestPort).toBe(3000)
      return { hostPort: port, url: `http://127.0.0.1:${port}` }
    },
    states: () => [
      { botId: bot.id, status: "running", error: null, progress: null, memoryMb: 2048, createdMs: 1, startMs: 1 },
    ],
  })
  const supervisor = createSupervisor({ kernel: f.runtime.kernel, store })
  try {
    const defined = supervisor.define({
      vmBotId: bot.id,
      project: created.project,
      name: "web",
      command: "pnpm dev",
      cwd: ".",
      env: {},
      autostart: false,
      restart: "never",
      dependsOn: [],
      ready: { port: 3000 },
      previewPort: 3000,
      createdBy: "agent",
    })
    if (!defined.success) throw new Error(defined.error)
    expect((await supervisor.start({ project: created.project, spec: defined.spec, waitMs: 3000 })).success).toBe(true)
    for (let attempt = 0; attempt < 20 && !events.some((event) => event.type === "preview.available"); attempt++)
      await Bun.sleep(50)
    expect(guestSpawns).toBe(1)
    expect(supervisor.previews()[0]).toMatchObject({ vmBotId: bot.id, port, url: `http://127.0.0.1:${port}/` })
    expect(supervisor.openPreview({ project: created.project, vmBotId: bot.id, port: 3000, path: "/" })).toMatchObject({
      success: true,
      preview: { port },
    })
  } finally {
    unsubscribe()
    await supervisor.stopAll()
  }
}, 20_000)

test("VM browser failure never falls back to a host browser", async () => {
  const f = await fixture()
  const bot = await f.bot()
  let endpoints = 0
  let hostSpawns = 0
  const kernel: Kernel = {
    ...f.runtime.kernel,
    spawnTree: () => {
      hostSpawns++
      return { success: false, errorCode: "SPAWN_FAILED", error: "host forbidden" }
    },
  }
  kernel.services.provide("vm.runtime", {
    ...f.vm.service,
    acquire: async () => async () => {},
    browserEndpoint: async () => {
      endpoints++
      throw new Error("guest browser failed")
    },
  })
  const browser = createRoutedBrowserEngine(kernel, "system-chrome")
  try {
    const result = await browser.open({
      url: "about:blank",
      timeoutMs: 1000,
      ctx: {
        botId: bot.id,
        threadId: bot.mainThreadId ?? "",
        runId: null,
        projectId: null,
        cwd: "/workspace",
        signal: new AbortController().signal,
      },
    })
    expect(result.success).toBe(false)
    expect(endpoints).toBeGreaterThan(0)
    expect(hostSpawns).toBe(0)
  } finally {
    await browser.shutdown()
  }
})

test("credential redaction holds token prefixes split across streamed deltas", async () => {
  const f = await fixture()
  const secret = "only-provider-secret"
  f.runtime.kernel.addRedactionValue(secret)
  const events: Array<import("@touri/contracts").ProviderEvent> = []
  const emit = redactVmEvents({
    secrets: [secret],
    redact: f.runtime.kernel.redact,
    emit: (event) => events.push(event),
  })
  emit({ type: "text_delta", itemId: "a", delta: "prefix only-provi" })
  expect(JSON.stringify(events)).not.toContain("only-provi")
  emit({ type: "text_delta", itemId: "a", delta: "der-secret suffix" })
  emit({ type: "turn_completed", status: "succeeded", errorClass: null, errorMessage: null })
  expect(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe("prefix [REDACTED] suffix")
})

test("composer intents coalesce one boot, refresh activity and expose only a connection keyId", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 1 })
  const [focus, typing] = await Promise.all([
    f.vm.service.intent({ botId: bot.id, intent: "composer-focus" }),
    f.vm.service.intent({ botId: bot.id, intent: "composer-typing" }),
  ])
  expect(focus.status).toBe("running")
  expect(typing.connection).toEqual(focus.connection)
  expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(1)
  const connection = focus.connection
  if (!connection) throw new Error("Missing connection")
  expect(connection).not.toHaveProperty("success")
  const key = f.connectionKeys.get(connection.machineId)
  if (!key) throw new Error("Missing test key")
  expect(connection).toMatchObject({
    endpoints: { browser: "", bridge: "tcp://127.0.0.1:49123" },
    display: { name: ":99", width: 1440, height: 900 },
  })
  expect(JSON.stringify(focus)).not.toContain(key.toString("base64"))
  const sealed = f.fake.files.get(connection.bridge.connectionFile) ?? ""
  expect(JSON.parse(sealed).keyId).toBe(connection.authKeyId)
  expect(sealed).not.toContain(key.toString("base64"))
  f.advance(50_000)
  await f.vm.service.intent({ botId: bot.id, intent: "composer-typing" })
  f.advance(30_000)
  await f.vm.service.intent({ botId: bot.id, intent: "idle" })
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(30_000)
  await f.vm.service.intent({ botId: bot.id, intent: "idle" })
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", connection: null })
})

test("background and final lease release preserve the workspace until real idleness", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const one = await f.vm.service.acquire({ botId: bot.id })
  const two = await f.vm.service.acquire({ botId: bot.id })
  expect((await f.vm.service.intent({ botId: bot.id, intent: "background" })).status).toBe("running")
  await one()
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
  await two()
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(600_000)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("stopped")
  expect(f.fake.calls.filter((call) => call.action === "deleteVolume")).toHaveLength(0)
  const resumed = await f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  const firstId = resumed.connection?.authKeyId
  const restarted = await f.vm.service.restart({ botId: bot.id })
  expect(restarted.connection?.authKeyId).not.toBe(firstId)
  expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(1)
  await f.vm.service.destroy({ botId: bot.id })
  expect(f.connectionKeys.size).toBe(0)
})

test("APP_BACKGROUND during prewarm preserves the completed boot for ten minutes", async () => {
  const f = await fixture()
  const bot = await f.bot()
  let ready: () => void = () => {}
  f.fake.provider.ensureImage = () =>
    new Promise<void>((resolve) => {
      ready = resolve
    })
  const warming = f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  for (let i = 0; i < 20 && f.vm.service.states()[0]?.status !== "starting"; i++) await Bun.sleep(1)
  const parking = f.vm.service.intent({ botId: bot.id, intent: "background" })
  ready()
  await Promise.all([warming, parking])
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(599_999)
  await f.vm.sweep()
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
  f.advance(1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("stopped")
})

test("background does not cancel a composer wake that is still queued", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const warm = f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  const park = f.vm.service.intent({ botId: bot.id, intent: "background" })
  expect((await warm).status).toBe("running")
  await park
  expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(1)
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
  expect(f.vm.service.states()[0]?.status).toBe("running")
})

test("machine intent route validates input and rejects local bots", async () => {
  const f = await fixture()
  f.runtime.kernel.registerRoutes({
    name: "machine-intents",
    routes: machineActionRoutes(f.runtime.kernel, f.vm.service),
  })
  const bot = await f.bot()
  expect((await f.request(`/bots/${bot.id}/machine/intent`, { intent: "invalid" })).status).toBe(400)
  const local = await f.bot({ machine: "local" })
  expect((await f.request(`/bots/${local.id}/machine/intent`, { intent: "composer-focus" })).status).toBe(409)
  const response = await f.request(`/bots/${bot.id}/machine/intent`, { intent: "composer-focus" })
  expect(response.status).toBe(200)
  expect((await response.json()).machine.connection.authKeyId).toMatch(/^[a-f0-9]{64}$/)
})

test("new typing cancels parking queued by the final lease behind a port operation", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const release = await f.vm.service.acquire({ botId: bot.id })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  const entered = deferred()
  const gate = deferred()
  const forward = f.fake.provider.forwardPort
  f.fake.provider.forwardPort = async (input) => {
    entered.resolve()
    await gate.promise
    return forward(input)
  }
  const forwarding = f.vm.service.forwardPort({ botId: bot.id, guestPort: 3000 })
  await entered.promise
  await release()
  const warming = f.vm.service.intent({ botId: bot.id, intent: "composer-typing" })
  gate.resolve()
  await Promise.all([forwarding, warming])
  expect(f.vm.service.states()[0]?.status).toBe("running")
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
})

test("background cannot park a new turn lease; idle parking waits for renewed activity", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 1 })
  const one = await f.vm.service.acquire({ botId: bot.id })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  const two = await f.vm.service.acquire({ botId: bot.id })
  await one()
  await two()
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  const turn = await f.vm.service.acquire({ botId: bot.id })
  f.advance(60_000)
  await f.vm.service.intent({ botId: bot.id, intent: "idle" })
  await turn()
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(60_000)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("stopped")
})

test("focus resumes an idle stop in flight and subsequent blur cannot park the new wake", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  const entered = deferred()
  const gate = deferred()
  const stop = f.fake.provider.stop
  f.fake.provider.stop = async (input) => {
    entered.resolve()
    await gate.promise
    return stop(input)
  }
  f.advance(600_000)
  const firstPark = f.vm.service.intent({ botId: bot.id, intent: "idle" })
  await entered.promise
  const warm = f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  const lastPark = f.vm.service.intent({ botId: bot.id, intent: "background" })
  gate.resolve()
  await Promise.all([firstPark, warm, lastPark])
  expect(f.vm.service.states()[0]?.status).toBe("running")
})

test("a new focus cancels background parking during first image preparation", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const entered = deferred()
  const gate = deferred()
  f.fake.provider.ensureImage = async () => {
    entered.resolve()
    await gate.promise
  }
  const warm = f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  await entered.promise
  const park = f.vm.service.intent({ botId: bot.id, intent: "background" })
  const focus = f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  gate.resolve()
  await Promise.all([warm, park, focus])
  expect(f.vm.service.states()[0]?.status).toBe("running")
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
})

test("paused bots do not prewarm and a failed park reports an error for retry", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await f.request(`/bots/${bot.id}`, { paused: true }, "PATCH")
  expect((await f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })).status).toBe("stopped")
  expect(f.fake.calls).toHaveLength(0)
  await f.request(`/bots/${bot.id}`, { paused: false }, "PATCH")
  await f.vm.service.intent({ botId: bot.id, intent: "composer-focus" })
  const stop = f.fake.provider.stop
  f.fake.provider.stop = async () => ({ success: false, errorCode: "COMMAND_FAILED", error: "park failed" })
  f.advance(600_000)
  await expect(f.vm.service.intent({ botId: bot.id, intent: "idle" })).rejects.toThrow("park failed")
  expect(f.vm.service.states()[0]).toMatchObject({ status: "error", connection: null })
  f.fake.provider.stop = stop
  f.advance(600_000)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("stopped")
})

test("a guest stopped externally rotates its key and reconnects the outbound bridge with the new token", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const sockets = new Set<Socket>()
  const tokens: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => sockets.delete(socket))
    let data = ""
    socket.on("data", (chunk) => {
      data += chunk.toString()
      if (data.includes("\n")) tokens.push((JSON.parse(data.trim()) as { token: string }).token)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test port")
  const forward = f.fake.provider.forwardPort
  f.fake.provider.forwardPort = (input) => forward({ ...input, hostPort: address.port })
  const waitTokens = async (count: number) => {
    for (let i = 0; i < 200 && tokens.length < count; i++) await Bun.sleep(5)
    expect(tokens).toHaveLength(count)
  }
  try {
    const first = await f.vm.service.prepareTurn({ botId: bot.id, threadId: "first", token: "first-thread-token" })
    await waitTokens(4)
    const connection = f.vm.service.states()[0]?.connection
    if (!connection) throw new Error("Missing connection")
    await first.release()
    f.fake.machines.set(connection.machineId, "stopped")
    const next = await f.vm.service.prepareTurn({ botId: bot.id, threadId: "next", token: "next-thread-token" })
    await waitTokens(8)
    expect(f.vm.service.states()[0]?.connection?.authKeyId).not.toBe(connection.authKeyId)
    expect(new Set(tokens.slice(0, 4)).size).toBe(1)
    expect(new Set(tokens.slice(4)).size).toBe(1)
    expect(tokens[4]).not.toBe(tokens[0])
    await next.release()
  } finally {
    await f.vm.service.stop({ botId: bot.id })
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("a stopped machine without the bot resolvers is recreated with BOT_DNS", async () => {
  const { BOT_DNS } = await import("../../src/vm/image")
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  await f.vm.service.stop({ botId: bot.id })
  const original = f.fake.calls.find((call) => call.action === "create")?.input as VmCreateOptions
  expect(original.dns).toEqual(BOT_DNS)
  f.fake.configs.set(original.name, { ...original, dns: [] })
  const offset = f.fake.calls.length
  await (await f.vm.service.acquire({ botId: bot.id }))()
  const recreated = f.fake.calls.slice(offset).find((call) => call.action === "create")?.input as VmCreateOptions
  expect(recreated?.dns).toEqual(BOT_DNS)
})

test("open computer tabs and terminals lease through idle and app background, independently per window", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 1 })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-visible", viewerId: "main-window" })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-visible", viewerId: "separate-window" })
  f.advance(60_000)
  await f.vm.service.intent({ botId: bot.id, intent: "idle" })
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  await f.vm.service.intent({ botId: bot.id, intent: "computer-hidden", viewerId: "main-window" })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  expect(f.vm.service.states()[0]?.status).toBe("running")
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
  await f.vm.service.intent({ botId: bot.id, intent: "computer-hidden", viewerId: "separate-window" })
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(59_999)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(1)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", pauseReason: "inactivity" })
  expect(readFileSync(join(f.runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")).toContain(
    "Máquina pausada por inatividade",
  )
})

test("computer presence does not boot a stopped machine and abandoned viewers expire", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 1 })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-visible", viewerId: "tab" })
  expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(0)
  await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
  f.advance(60_000)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  f.advance(60_000)
  await f.vm.sweep()
  expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", pauseReason: "inactivity" })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
  expect(f.vm.service.states()[0]?.pauseReason).toBeNull()
})

test("queued and running turns protect the machine before and between runtime acquisitions", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 1 })
  const thread = await f.request("/threads", { botId: bot.id })
  const { thread: created } = (await thread.json()) as { thread: { id: string } }
  const persistence = createRuntimePersistence({ database: f.runtime.kernel.db })
  persistence.saveRun({
    id: "lease-run",
    threadId: created.id,
    botId: bot.id,
    provider: "codex",
    trigger: "user",
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    status: "queued",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  })
  await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
  f.advance(60_000)
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  const db = f.runtime.kernel.db as Database
  db.query("UPDATE runs SET status = 'running' WHERE id = ?").run("lease-run")
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  db.query("UPDATE runs SET status = 'succeeded' WHERE id = ?").run("lease-run")
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("stopped")
})

test("UI render errors are authenticated, bounded and redacted in the sidecar log", async () => {
  const f = await fixture()
  f.runtime.kernel.addRedactionValue("render-secret")
  const body = {
    area: "o diálogo",
    message: "render-secret",
    stack: "Error: render-secret",
    componentStack: "at Settings",
  }
  const unauthenticated = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/ui/errors`, {
    method: "POST",
    body: JSON.stringify(body),
  })
  expect(unauthenticated.status).toBe(401)
  expect((await f.request("/ui/errors", { ...body, stack: "x".repeat(16_001) })).status).toBe(400)
  expect((await f.request("/ui/errors", body)).status).toBe(200)
  const log = readFileSync(join(f.runtime.kernel.paths.logsDir, "sidecar.log"), "utf8")
  expect(log).toContain("Falha de renderização")
  expect(log).toContain("[REDACTED]")
  expect(log).not.toContain("render-secret")
})

test("background does not mark an unused or explicitly stopped machine as paused by inactivity", async () => {
  const f = await fixture()
  const bot = await f.bot()
  expect((await f.vm.service.intent({ botId: bot.id, intent: "background" })).pauseReason).toBeUndefined()
  await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
  await f.vm.service.stop({ botId: bot.id })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  expect(f.vm.service.states()[0]?.pauseReason).toBeNull()
})

test("an acquisition waiting behind another operation prevents a previously queued park", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const release = await f.vm.service.acquire({ botId: bot.id })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  const entered = deferred()
  const gate = deferred()
  const forward = f.fake.provider.forwardPort
  f.fake.provider.forwardPort = async (input) => {
    entered.resolve()
    await gate.promise
    return forward(input)
  }
  const forwarding = f.vm.service.forwardPort({ botId: bot.id, guestPort: 3000 })
  await entered.promise
  await release()
  const next = f.vm.service.acquire({ botId: bot.id })
  gate.resolve()
  await forwarding
  const releaseNext = await next
  expect(f.fake.calls.filter((call) => call.action === "stop")).toHaveLength(0)
  expect(f.vm.service.states()[0]?.status).toBe("running")
  await releaseNext()
})

test("returning to the app cancels background park pending behind a lease without starting other bots", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const release = await f.vm.service.acquire({ botId: bot.id })
  await f.vm.service.intent({ botId: bot.id, intent: "background" })
  await f.vm.service.intent({ botId: bot.id, intent: "foreground" })
  await release()
  await f.vm.sweep()
  expect(f.vm.service.states()[0]?.status).toBe("running")
  const unused = await f.bot()
  expect((await f.vm.service.intent({ botId: unused.id, intent: "foreground" })).status).toBe("stopped")
})

test("connected computer panels survive suspended UI timers and release only when their socket closes", async () => {
  const f = await fixture()
  const bot = await f.bot({ machineIdleMinutes: 1 })
  const disconnected = deferred()
  const holdViewer = f.vm.service.holdViewer
  if (!holdViewer) throw new Error("Viewer leases unavailable")
  f.vm.service.holdViewer = (id) => {
    const release = holdViewer(id)
    return () => {
      release()
      disconnected.resolve()
    }
  }
  const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
  const path = `/api/v1/bots/${bot.id}/machine/presence/socket`
  const ticket = await socketTicket(f.runtime.handshake.port, path)
  const socket = new NativeSocket(`ws://127.0.0.1:${f.runtime.handshake.port}${path}?ticket=${ticket}`, {
    headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "vm-test" },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", reject, { once: true })
    })
    expect(f.fake.calls.filter((call) => call.action === "create")).toHaveLength(0)
    await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
    f.advance(15 * 60_000)
    await f.vm.service.intent({ botId: bot.id, intent: "idle" })
    await f.vm.service.intent({ botId: bot.id, intent: "background" })
    await f.vm.sweep()
    expect(f.vm.service.states()[0]?.status).toBe("running")
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
    socket.close()
    await closed
    await disconnected.promise
    await f.vm.sweep()
    expect(f.vm.service.states()[0]?.status).toBe("running")
    f.advance(60_000)
    await f.vm.sweep()
    expect(f.vm.service.states()[0]).toMatchObject({ status: "stopped", pauseReason: "inactivity" })
  } finally {
    socket.close()
  }
})

test("OpenCode hands the selected host auth to the guest and never copies host settings", async () => {
  const f = await fixture()
  mkdirSync(join(f.root, "host-home", ".local/share/opencode"), { recursive: true })
  const auth = JSON.stringify({ openrouter: { type: "api", key: "opencode-router-secret" } })
  writeFileSync(join(f.root, "host-home", ".local/share/opencode/auth.json"), auth)
  const bot = await f.bot({ provider: "opencode", vmProviderLogin: true })
  const prepared = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "opencode-thread",
    token: "opencode-mcp",
  })
  expect(prepared.bot.provider).toBe("opencode")
  expect(prepared.execution.connect).toBeDefined()
  expect(f.fake.files.get("/workspace/.home/.local/share/opencode/auth.json")).toBe(auth)
  expect(f.runtime.kernel.redact("opencode-router-secret")).not.toContain("opencode-router-secret")
  expect(
    f.fake.calls.some(
      (call) =>
        call.action === "exec" &&
        JSON.stringify(call.input).includes("/workspace/.home/.local/share/opencode/auth.json"),
    ),
  ).toBe(true)
  await prepared.release()
  await f.vm.service.stop({ botId: bot.id })
  expect(f.fake.files.has("/workspace/.home/.local/share/opencode/auth.json")).toBe(false)
})

test("OpenCode VM can use provider environment keys without requiring Codex login commands", async () => {
  const f = await fixture()
  const bot = await f.bot({ provider: "opencode", vmProviderLogin: false })
  const prepared = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "opencode-thread",
    token: "mcp",
  })
  expect(
    f.fake.calls.some(
      (call) =>
        call.action === "exec" &&
        JSON.stringify(call.input).includes('"command":"opencode"') &&
        JSON.stringify(call.input).includes('"login"'),
    ),
  ).toBe(false)
  await prepared.release()
})

test("B11 failure to install packet policy blocks readiness and stops the VM", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const original = f.fake.provider.exec
  f.fake.provider.exec = (input) =>
    input.args?.includes("/usr/local/lib/touri/network-policy.py")
      ? Promise.resolve({ success: false, errorCode: "COMMAND_FAILED", error: "nft unavailable" })
      : original(input)
  await expect(f.vm.service.acquire({ botId: bot.id })).rejects.toThrow("proteção de rede")
  expect(f.fake.calls.some((call) => call.action === "stop")).toBe(true)
  expect(f.vm.service.states()[0]?.status).toBe("error")
  expect(f.vm.service.states().some((state) => state.status === "running")).toBe(false)
})

test("B11 LAN policy tightens live, and loosening activates only after restart", async () => {
  const { saveEgressPolicy, defaultEgressPolicy, readEgressPolicy } = await import("../../src/vm/egress-policy")
  const f = await fixture()
  const bot = await f.bot()
  const release = await f.vm.service.acquire({ botId: bot.id })
  saveEgressPolicy(f.runtime.kernel, bot.id, { ...defaultEgressPolicy(), allowLan: true })
  await f.vm.applyNetworkPolicy(bot.id)
  expect(readEgressPolicy(f.runtime.kernel, bot.id, true).allowLan).toBe(false)
  await release()
  await f.vm.service.restart({ botId: bot.id })
  expect(readEgressPolicy(f.runtime.kernel, bot.id, true).allowLan).toBe(true)
  saveEgressPolicy(f.runtime.kernel, bot.id, defaultEgressPolicy())
  await f.vm.applyNetworkPolicy(bot.id)
  expect(readEgressPolicy(f.runtime.kernel, bot.id, true).allowLan).toBe(false)
})

test("B07 persisted host-login staging is revoked after sidecar restart before guest-owned login is used", async () => {
  const f = await fixture()
  const bot = await f.bot()
  await (await f.vm.service.acquire({ botId: bot.id }))()
  f.fake.files.set("/workspace/.home/.codex/auth.json", "synthetic interrupted host login")
  const db = f.runtime.kernel.db as Database
  db.query("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)").run(
    `vm-staged-login:${bot.id}`,
    '["codex"]',
    Date.now(),
  )
  const next = createVmRuntime({
    kernel: f.runtime.kernel,
    provider: f.fake.provider,
    capability: f.vm.service.capability,
  })
  try {
    const turn = await next.service.prepareTurn({
      botId: bot.id,
      threadId: bot.mainThreadId ?? "thread",
      token: "test-token",
    })
    expect(f.fake.files.has("/workspace/.home/.codex/auth.json")).toBe(false)
    expect(db.query("SELECT 1 FROM settings WHERE key = ?").get(`vm-staged-login:${bot.id}`)).toBeNull()
    await turn.release()
  } finally {
    await next.dispose()
  }
})

test("B11 thrown policy installer stops the VM just like an unsuccessful result", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const original = f.fake.provider.exec
  f.fake.provider.exec = async (input) => {
    if (input.args?.includes("/usr/local/lib/touri/network-policy.py")) throw new Error("cancelled install")
    return original(input)
  }
  await expect(f.vm.service.acquire({ botId: bot.id })).rejects.toThrow("proteção de rede")
  expect(f.fake.calls.some((call) => call.action === "stop")).toBe(true)
})

test("B07 a delayed previous credential cleanup cannot delete the next turn's login", async () => {
  const f = await fixture()
  const bot = await f.bot({ vmProviderLogin: true })
  const threadId = bot.mainThreadId ?? "thread"
  const first = await f.vm.service.prepareTurn({ botId: bot.id, threadId, token: "a" })
  const original = f.fake.provider.exec
  const entered = deferred()
  const finish = deferred()
  f.fake.provider.exec = async (input) => {
    if (input.command === "rm" && input.args?.includes("/workspace/.home/.codex/auth.json")) {
      entered.resolve()
      await finish.promise
    }
    return original(input)
  }
  await first.release()
  await entered.promise
  let ready = false
  const next = f.vm.service.prepareTurn({ botId: bot.id, threadId, token: "b" }).then((value) => {
    ready = true
    return value
  })
  try {
    await Bun.sleep(15)
    expect(ready).toBe(false)
    finish.resolve()
    const turn = await next
    expect(f.fake.files.get("/workspace/.home/.codex/auth.json")).toContain("only-provider-secret")
    await turn.release()
  } finally {
    finish.resolve()
  }
})

for (const provider of ["claude", "codex"] as const) {
  test(`VM ${provider} login readiness probe launches with the shared privacy env`, async () => {
    const f = await fixture()
    const bot = await f.bot({ provider })
    const probes: Array<Record<string, string> | undefined> = []
    const original = f.fake.provider.exec
    f.fake.provider.exec = async (input) => {
      if (input.command === provider) probes.push(input.env)
      return original(input)
    }
    const turn = await f.vm.service.prepareTurn({ botId: bot.id, threadId: bot.mainThreadId ?? "thread", token: "t" })
    await turn.release()
    expect(probes.length).toBeGreaterThan(0)
    for (const env of probes) {
      expect(env).toMatchObject({ DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", OTEL_SDK_DISABLED: "true" })
      expect(env?.HOME).toBe("/workspace/.home")
    }
    expect(turn.env).toMatchObject({ DISABLE_TELEMETRY: "1" })
  })
}

test("folder changes keep an active VM intact and recreate it with the same workspace on the next turn", async () => {
  const f = await fixture()
  const bot = await f.bot()
  const folder = join(f.root, "grant")
  mkdirSync(folder)
  const release = await f.vm.service.acquire({ botId: bot.id })
  const initial = [...f.fake.configs.values()][0]
  const workspace = initial?.volumes?.find((mount) => mount.target === "/workspace")
  const response = await f.request(
    `/bots/${bot.id}`,
    { folders: [{ path: folder, access: "read-only" }], anyFolderAccess: true },
    "PATCH",
  )
  expect(response.status).toBe(200)
  expect(f.fake.calls.filter((call) => call.action === "destroy")).toHaveLength(0)
  await release()
  await f.vm.service.intent({ botId: bot.id, intent: "computer-open" })
  expect(f.fake.calls.filter((call) => call.action === "destroy")).toHaveLength(0)
  const next = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "thread",
    token: "test-folders",
  })
  const updated = [...f.fake.configs.values()][0]
  expect(f.fake.calls.filter((call) => call.action === "destroy")).toHaveLength(1)
  expect(updated?.volumes).toContainEqual(workspace)
  expect(updated?.volumes?.some((mount) => mount.target.startsWith("/host/grant-") && mount.readOnly)).toBe(true)
  expect(updated?.volumes?.some((mount) => mount.target === "/host/home" && !mount.readOnly)).toBe(true)
  await next.release()
  const removed = await f.request(`/bots/${bot.id}`, { folders: [], anyFolderAccess: false }, "PATCH")
  expect(removed.status).toBe(200)
  const third = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "thread",
    token: "test-removed",
  })
  expect([...f.fake.configs.values()][0]?.volumes?.some((mount) => mount.target.startsWith("/host/"))).toBe(false)
  expect([...f.fake.configs.values()][0]?.volumes).toContainEqual(workspace)
  await third.release()
})

test("a delayed vault read uses the same five-second allowance as chat and reaches the VM turn", async () => {
  const f = await fixture()
  const bot = await f.bot({ provider: "claude", vmProviderLogin: true })
  ;(f.runtime.kernel.db as Database)
    .query("INSERT INTO settings VALUES (?, ?, 1)")
    .run(`vm-login-source:${bot.id}:claude`, '"vault"')
  f.runtime.kernel.callHost = (async () => {
    await Bun.sleep(3100)
    return { success: true, value: { value: "sk-ant-oat01-synthetic-delayed-token" } }
  }) as Kernel["callHost"]
  const prepared = await f.vm.service.prepareTurn({
    botId: bot.id,
    threadId: bot.mainThreadId ?? "thread",
    token: "mcp",
  })
  expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-synthetic-delayed-token")
  await prepared.release()
}, 10000)

test("VM automatic input waits for explicit handback and kill prevents any further guest injection", async () => {
  const f = await fixture()
  const bot = await f.bot({ computerUse: true })
  await initComputer(f.runtime.kernel)
  const gate = f.runtime.kernel.services.use("computer.input")
  if (!gate) throw new Error("Missing input owner")
  const ctx = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    runId: null,
    projectId: null,
    cwd: "/workspace",
    signal: new AbortController().signal,
  }
  const spawn = f.fake.provider.spawn
  f.fake.provider.spawn = (input) => {
    const child = spawn(input)
    return child.success
      ? {
          ...child,
          stdout: new Response(JSON.stringify({ data: "cG5n", scale: 1 })).body as ReadableStream<Uint8Array>,
        }
      : child
  }
  await gate.take(bot.id, ctx.signal)
  const pending = f.vm.service.computer({ ctx, name: "computer_type", args: { text: "next" } })
  await Bun.sleep(10)
  expect(f.fake.calls.filter((call) => call.action === "spawn")).toHaveLength(0)
  gate.handBack(bot.id)
  expect(await pending).toMatchObject({ success: false, errorCode: "COMPUTER_NO_SCREENSHOT" })
  const injections = () =>
    f.fake.calls.filter((call) => call.action === "spawn" && JSON.stringify(call.input).includes("computer.py"))
  expect(injections()).toHaveLength(0)
  expect((await f.vm.service.computer({ ctx, name: "computer_screenshot", args: {} })).success).toBe(true)
  expect((await f.vm.service.computer({ ctx, name: "computer_type", args: { text: "next" } })).success).toBe(true)
  expect(injections()).toHaveLength(2)
  gate.kill()
  expect((await f.vm.service.computer({ ctx, name: "computer_type", args: { text: "again" } })).success).toBe(false)
  expect(injections()).toHaveLength(2)
})

test("queued VM input rechecks read-only access before guest injection", async () => {
  const f = await fixture()
  const bot = await f.bot({ computerUse: true })
  await initComputer(f.runtime.kernel)
  const gate = f.runtime.kernel.services.use("computer.input")
  if (!gate) throw new Error("Missing input owner")
  const ctx = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    runId: null,
    projectId: null,
    cwd: "/workspace",
    signal: new AbortController().signal,
  }
  const spawn = f.fake.provider.spawn
  f.fake.provider.spawn = (input) => {
    const child = spawn(input)
    return child.success
      ? { ...child, stdout: new Response(JSON.stringify({ scale: 1 })).body as ReadableStream<Uint8Array> }
      : child
  }
  let finish = () => {}
  const active = gate.run(ctx, async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { success: true, content: [] }
  })
  const pending = f.vm.service.computer({ ctx, name: "computer_type", args: { text: "queued" } })
  expect((await f.request(`/bots/${bot.id}`, { access: "read-only" }, "PATCH")).status).toBe(200)
  finish()
  await active
  expect(await pending).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(
    f.fake.calls.filter((call) => call.action === "spawn" && JSON.stringify(call.input).includes("computer.py")),
  ).toHaveLength(0)
})

test("turn setup writes its token and instructions concurrently before starting the provider", async () => {
  const f = await fixture(true, { exec: 500 })
  const bot = await f.bot({ vmProviderLogin: true })
  const spawn = f.fake.provider.spawn
  const writes: string[] = []
  const bothStarted = deferred()
  let bridgeStarted = false
  const forward = f.fake.provider.forwardPort
  f.fake.provider.forwardPort = async (input) => {
    bridgeStarted = true
    if (writes.length === 2) bothStarted.resolve()
    return forward(input)
  }
  f.fake.provider.spawn = (input) => {
    const child = spawn(input)
    const path = input.args?.at(-1) ?? ""
    if (!child.success || (!path.endsWith(".token") && path !== "/workspace/.home/SOUL.md")) return child
    writes.push(path)
    if (writes.length === 2 && bridgeStarted) bothStarted.resolve()
    return {
      ...child,
      exited: child.exited.then(async (outcome) => {
        await bothStarted.promise
        return outcome
      }),
    }
  }
  try {
    const turn = await f.vm.service.prepareTurn({
      botId: bot.id,
      threadId: bot.mainThreadId ?? "thread",
      token: "parallel-token",
    })
    expect(writes).toHaveLength(2)
    expect(bridgeStarted).toBe(true)
    expect(f.fake.files.get("/workspace/.home/SOUL.md")).toBe(bot.instructions)
    await turn.release()
  } finally {
    bothStarted.resolve()
  }
})
