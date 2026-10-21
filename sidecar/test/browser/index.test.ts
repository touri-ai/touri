import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import type { Bot, BrowserTabInfo, RouteModule, ToolRegistration, ToolResult, VmRuntime } from "@touri/contracts"
import { init, withToolDeadline } from "../../src/browser"
import { createBrowserEngine } from "../../src/browser/engine"
import type { BrowserEngine } from "../../src/browser/types"
import { init as initComputer } from "../../src/computer"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { init as initStore } from "../../src/store"
import "./test-helper"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  const pending = [...cleanups]
  cleanups.clear()
  for (const cleanup of pending) await cleanup()
})

const getTakeoverVmRuntime = (acquire: VmRuntime["acquire"]): VmRuntime => {
  const state = {
    botId: "test-bot",
    status: "running" as const,
    progress: null,
    error: null,
    memoryMb: 512,
    createdMs: null,
    startMs: null,
  }
  return {
    capability: { available: true, reason: null, provider: "test" },
    states: () => [],
    intent: async () => state,
    acquire,
    spawn: () => ({ success: false, errorCode: "SPAWN_FAILED", error: "Fixture runtime" }),
    exec: async () => ({ success: false, errorCode: "EXEC_FAILED", error: "Fixture runtime" }),
    writeFile: async () => {},
    prepareTurn: async () => {
      throw new Error("Fixture runtime")
    },
    forwardPort: async () => ({ hostPort: 0, url: "http://example.test" }),
    desktopConnection: async () => ({ hostPort: 0, url: "http://example.test", password: "fixture" }),
    browserEndpoint: async () => null,
    computer: async () => ({ success: false, errorCode: "COMPUTER_DISABLED", error: "Fixture runtime" }),
    restart: async () => state,
    startService: async () => null,
    stop: async () => {},
    destroy: async () => {},
    doctor: async () => [],
  }
}

test("browser init registers its routes and optional tab service", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-wp6-index-"))
  const runtime = createKernel({ appData: root })
  try {
    await init(runtime.kernel)
    const tabsForBot = runtime.kernel.services.use("browser.tabsForBot")
    expect(tabsForBot?.({ botId: "bot-with-no-tabs" })).toEqual([])

    const baseUrl = `http://127.0.0.1:${runtime.handshake.port}`
    const tabsResponse = await fetch(`${baseUrl}/api/v1/browser/tabs`, {
      headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
    })
    expect(tabsResponse.status).toBe(200)
    expect(await tabsResponse.json()).toEqual({ tabs: [] })

    const takeoverResponse = await fetch(`${baseUrl}/api/v1/browser/tabs/missing/takeover`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hold: false }),
    })
    expect(takeoverResponse.status).toBe(404)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("remote browser takeover gives one device an interactive session and rejects other session tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-remote-takeover-"))
  const runtime = createKernel({ appData: root })
  let botId = ""
  let receivedInput: unknown = null
  let inputSignals: ReadonlyArray<AbortSignal> = []
  let inputAuthorization: ReadonlyArray<() => boolean> = []
  let engineReleaseCount = 0
  let leaseAcquired = 0
  let leaseReleased = 0
  const registeredModules: Array<RouteModule> = []
  const getResult = (): ToolResult => ({ success: true, content: [] })
  const tab: BrowserTabInfo & { ownerBotId: string | null; ownerThreadId: string | null } = {
    tabId: "t_remote",
    title: "Example page",
    url: "https://example.test/login",
    state: "live",
    openerTabId: null,
    heldByUser: false,
    lastUsedAt: Date.now(),
    ownerBotId: botId,
    ownerThreadId: null,
  }
  const engine: BrowserEngine = {
    preview: async () => null,
    open: async () => getResult(),
    list: async () => getResult(),
    close: async () => getResult(),
    snapshot: async () => getResult(),
    screenshot: async () => getResult(),
    navigate: async () => getResult(),
    click: async () => getResult(),
    type: async () => getResult(),
    press: async () => getResult(),
    hover: async () => getResult(),
    scroll: async () => getResult(),
    selectOption: async () => getResult(),
    setChecked: async () => getResult(),
    waitFor: async () => getResult(),
    evaluate: async () => getResult(),
    requestTakeover: async () => getResult(),
    submitSecret: async () => getResult(),
    secretEntry: async () => false,
    releaseTakeover: async () => {
      engineReleaseCount += 1
      return true
    },
    holdTakeover: async () => true,
    getWindowBounds: async () => null,
    tabsForBot: () => [{ ...tab, ownerBotId: botId }],
    takeoverFrame: async () => ({
      targetEpoch: 4,
      title: "Example page",
      url: "https://example.test/login",
      image: "data:image/jpeg;base64,ZmFrZQ==",
      width: 1280,
      height: 720,
    }),
    takeoverInput: async ({ input, signal, isAuthorized }) => {
      if (isAuthorized) inputAuthorization = inputAuthorization.concat(isAuthorized)
      inputSignals = inputSignals.concat(signal)
      receivedInput = input
      return true
    },
    shutdown: async () => {},
  }
  try {
    const registerRoutes = runtime.kernel.registerRoutes
    runtime.kernel.registerRoutes = (module) => {
      registeredModules.push(module)
      registerRoutes(module)
    }
    await initStore(runtime.kernel)
    await init(runtime.kernel, undefined, { engine })
    const baseUrl = `http://127.0.0.1:${runtime.handshake.port}/api/v1`
    const request = (path: string, body: unknown, method = "POST") =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: "Bearer dev-ui-token",
          "x-touri-client": "browser-takeover-test",
          "Content-Type": "application/json",
        },
        ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
      })
    const botResponse = await request("/bots", { name: "Léo", machine: "local", provider: "codex" })
    expect(botResponse.status).toBe(201)
    botId = ((await botResponse.json()) as { bot: Bot }).bot.id
    ;(runtime.kernel.db as import("bun:sqlite").Database)
      .query("UPDATE bots SET machine = 'vm', browser = 'machine' WHERE id = ?")
      .run(botId)
    runtime.kernel.services.provide(
      "vm.runtime",
      getTakeoverVmRuntime(async () => {
        leaseAcquired += 1
        return async () => {
          leaseReleased += 1
        }
      }),
    )

    const started = await request("/browser/tabs/t_remote/takeover/session", {})
    expect(started.status).toBe(200)
    expect(leaseAcquired).toBe(1)
    expect(leaseReleased).toBe(0)
    const { sessionId, controlEpoch } = (await started.json()) as { sessionId: string; controlEpoch: string }
    expect(sessionId).toHaveLength(64)
    expect(controlEpoch).toHaveLength(32)

    const hiddenPreview = await request(`/bots/${botId}/browser-preview`, {}, "GET")
    expect(hiddenPreview.status).toBe(409)
    const tabs = await request(`/browser/tabs?botId=${botId}`, {}, "GET")
    expect(await tabs.json()).toMatchObject({
      tabs: [{ title: "", url: "" }],
    })

    const reconnected = await request("/browser/tabs/t_remote/takeover/session", {})
    expect(reconnected.status).toBe(200)
    expect(await reconnected.json()).toEqual({ sessionId, controlEpoch, viewEpoch: 0 })

    const denied = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId: "another-device-session",
      controlEpoch,
      input: { kind: "text", text: "private-login-value" },
    })
    expect(denied.status).toBe(403)
    expect(receivedInput).toBeNull()

    const staleControl = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch: "stale-control-epoch",
      targetEpoch: 4,
      viewEpoch: 0,
      width: 1280,
      height: 720,
      input: { kind: "text", text: "private-login-value" },
    })
    expect(staleControl.status).toBe(403)
    expect(receivedInput).toBeNull()

    const frame = await request("/browser/tabs/t_remote/takeover/frame", { sessionId, controlEpoch, viewEpoch: 0 })
    expect(frame.status).toBe(200)
    expect(await frame.json()).toMatchObject({ controlEpoch, targetEpoch: 4, viewEpoch: 0, width: 1280, height: 720 })

    const staleTarget = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch,
      targetEpoch: 3,
      viewEpoch: 0,
      width: 1280,
      height: 720,
      input: { kind: "text", text: "private-login-value" },
    })
    expect(staleTarget.status).toBe(409)
    expect(receivedInput).toBeNull()

    const staleGeometry = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch,
      targetEpoch: 4,
      viewEpoch: 0,
      width: 800,
      height: 600,
      input: { kind: "text", text: "private-login-value" },
    })
    expect(staleGeometry.status).toBe(409)
    expect(receivedInput).toBeNull()

    const resizedFrame = await request("/browser/tabs/t_remote/takeover/frame", {
      sessionId,
      controlEpoch,
      viewEpoch: 1,
    })
    expect(resizedFrame.status).toBe(200)
    expect(await resizedFrame.json()).toMatchObject({ controlEpoch, targetEpoch: 4, viewEpoch: 1 })
    const resumedAfterResize = await request("/browser/tabs/t_remote/takeover/session", {})
    expect(resumedAfterResize.status).toBe(200)
    expect(await resumedAfterResize.json()).toEqual({ sessionId, controlEpoch, viewEpoch: 1 })

    const staleView = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch,
      targetEpoch: 4,
      viewEpoch: 0,
      width: 1280,
      height: 720,
      input: { kind: "text", text: "private-login-value" },
    })
    expect(staleView.status).toBe(409)
    expect(receivedInput).toBeNull()

    const typed = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch,
      targetEpoch: 4,
      viewEpoch: 1,
      width: 1280,
      height: 720,
      input: { kind: "text", text: "private-login-value" },
    })
    expect(typed.status).toBe(200)
    expect(receivedInput).toEqual({ kind: "text", text: "private-login-value" })
    expect(await typed.text()).not.toContain("private-login-value")

    const keyed = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch,
      targetEpoch: 4,
      viewEpoch: 1,
      width: 1280,
      height: 720,
      input: { kind: "key", phase: "down", key: "Enter", code: "Enter", modifiers: 0 },
    })
    expect(keyed.status).toBe(200)
    expect(receivedInput).toEqual({ kind: "key", phase: "down", key: "Enter", code: "Enter", modifiers: 0 })

    const oversizedInput = await request("/browser/tabs/t_remote/takeover/input", {
      sessionId,
      controlEpoch,
      targetEpoch: 4,
      viewEpoch: 1,
      width: 1280,
      height: 720,
      input: { kind: "text", text: "x".repeat(70_000) },
    })
    expect(oversizedInput.status).toBe(400)
    expect(receivedInput).toEqual({ kind: "key", phase: "down", key: "Enter", code: "Enter", modifiers: 0 })

    const ended = await request("/browser/tabs/t_remote/takeover/session", { sessionId, controlEpoch }, "DELETE")
    expect(ended.status).toBe(200)
    expect(inputSignals.length).toBeGreaterThan(0)
    expect(inputSignals.every((signal) => signal.aborted)).toBe(true)
    expect(inputAuthorization.length).toBeGreaterThan(0)
    expect(inputAuthorization.every((isAuthorized) => !isAuthorized())).toBe(true)
    expect(leaseReleased).toBe(1)

    const browserRoutes = registeredModules.find(({ name }) => name === "browser")
    const startSessionRoute = browserRoutes?.routes.find(
      (route) => route.method === "POST" && route.path === "/browser/tabs/:id/takeover/session",
    )
    const endSessionRoute = browserRoutes?.routes.find(
      (route) => route.method === "DELETE" && route.path === "/browser/tabs/:id/takeover/session",
    )
    const legacyTakeoverRoute = browserRoutes?.routes.find(
      (route) => route.method === "POST" && route.path === "/browser/tabs/:id/takeover",
    )
    if (!startSessionRoute || !endSessionRoute || !legacyTakeoverRoute)
      throw new Error("Browser takeover routes were not registered")
    const personSignal = (personId: string) => {
      const signal = new AbortController().signal
      bindDeviceSession(signal, {
        deviceId: "shared-device",
        person: { id: personId, name: personId, email: null, avatarSeed: personId, role: "member" },
        active: () => true,
      })
      return signal
    }
    runtime.kernel.services.provide("work.canAccessBot", () => true)
    runtime.kernel.services.provide("work.canAccessThread", () => true)
    const ownerSignal = personSignal("controller")
    const ownerSession = await startSessionRoute.handler({
      params: { id: "t_remote" },
      query: {},
      body: {},
      signal: ownerSignal,
    })
    expect(ownerSession.status).toBe(200)
    if (!("json" in ownerSession)) throw new Error("Controller session response was not JSON")
    const ownerCredentials = ownerSession.json as { sessionId: string; controlEpoch: string }
    const releasesBeforeOtherPerson = engineReleaseCount
    const otherPersonRelease = await legacyTakeoverRoute.handler({
      params: { id: "t_remote" },
      query: {},
      body: { hold: false },
      signal: personSignal("another-person"),
    })
    expect(otherPersonRelease.status).toBe(403)
    expect(engineReleaseCount).toBe(releasesBeforeOtherPerson)
    const ownerEnd = await endSessionRoute.handler({
      params: { id: "t_remote" },
      query: {},
      body: ownerCredentials,
      signal: ownerSignal,
    })
    expect(ownerEnd.status).toBe(200)
    expect(leaseReleased).toBe(2)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("chat browser preview validates bot and running source without launching a browser or VM", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-preview-"))
  const runtime = createKernel({ appData: root })
  try {
    await initStore(runtime.kernel)
    await init(runtime.kernel)
    const request = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "preview-test" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    expect((await request("/bots/missing/browser-preview")).status).toBe(404)
    const local = (await (await request("/bots", { name: "Local", machine: "local", provider: "codex" })).json()) as {
      bot: { id: string }
    }
    expect((await request(`/bots/${local.bot.id}/browser-preview`)).status).toBe(409)
    ;(runtime.kernel.db as { run: (sql: string, ...args: string[]) => unknown }).run(
      "UPDATE bots SET machine = 'vm' WHERE id = ?",
      local.bot.id,
    )
    expect((await request(`/bots/${local.bot.id}/browser-preview`)).status).toBe(409)
    let launches = 0
    const engine = createBrowserEngine({
      kernel: runtime.kernel,
      launcher: {
        start: async () => {
          launches++
          return null
        },
        stop: async () => {},
      },
    })
    expect(await engine.preview({ botId: local.bot.id, signal: new AbortController().signal })).toBeNull()
    expect(launches).toBe(0)
    await engine.shutdown()
  } finally {
    runtime.emitHostNotification({ method: "app.willQuit", params: {} })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([1, 10])(
  "browser preview stays below 50 ms event-loop lag for %i viewers of 1 Hz maximum-sized frames",
  async (viewers) => {
    const root = mkdtempSync(join(tmpdir(), "touri-preview-lag-"))
    const runtime = createKernel({ appData: root })
    let stopSampler = (): void => {}
    let shutdownEngine = async (): Promise<void> => {}
    cleanups.add(async () => {
      stopSampler()
      await shutdownEngine()
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    })
    await initStore(runtime.kernel)
    let previewCount = 0
    const image = `data:image/jpeg;base64,${"A".repeat(1_500_000)}`
    const baseEngine = createBrowserEngine({
      kernel: runtime.kernel,
      launcher: {
        start: async () => null,
        stop: async () => {},
      },
    })
    shutdownEngine = () => baseEngine.shutdown()
    const engine = {
      ...baseEngine,
      tabsForBot: (botId: string | null) =>
        botId
          ? [
              {
                tabId: "synthetic-preview-tab",
                ownerBotId: botId,
                ownerThreadId: null,
                state: "live" as const,
                url: "https://example.test",
                title: "Synthetic",
                openerTabId: null,
                heldByUser: false,
                lastUsedAt: 1,
              },
            ]
          : [],
      preview: async () => {
        previewCount += 1
        return { title: "Página fictícia", url: "https://example.test/", image }
      },
    }
    await init(runtime.kernel, undefined, { engine })
    const request = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "preview-lag-test" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    const created = await request("/bots", { name: "Preview lag fixture", machine: "local", provider: "codex" })
    expect(created.status).toBe(201)
    const { bot } = (await created.json()) as { bot: { id: string } }
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    stopSampler = () => delay.disable()
    let payloadBytes = 0

    for (let sample = 0; sample < 5; sample += 1) {
      const responses = await Promise.all(
        Array.from({ length: viewers }, () => request(`/bots/${bot.id}/browser-preview`)),
      )
      expect(responses.every((response) => response.status === 200)).toBe(true)
      const payloads = await Promise.all(responses.map((response) => response.arrayBuffer()))
      payloadBytes = payloads[0]?.byteLength ?? 0
      if (sample < 4) await Bun.sleep(1_000)
    }

    delay.disable()
    const maxTickMs = Number((delay.max / 1_000_000).toFixed(2))
    const p99TickMs = Number((delay.percentile(99) / 1_000_000).toFixed(2))
    console.info(
      "[browser-preview sidecar benchmark]",
      JSON.stringify({ samples: previewCount, viewers, intervalMs: 1_000, payloadBytes, maxTickMs, p99TickMs }),
    )
    expect(previewCount).toBe(5)
    expect(p99TickMs).toBeLessThan(50)
    expect(maxTickMs).toBeLessThan(250)
  },
)

test("a browser tool answers within its timeoutMs even when the engine never settles", async () => {
  let aborted: AbortSignal | null = null
  let budget = 0
  const started = Date.now()
  const result = await withToolDeadline({
    ctx: { signal: new AbortController().signal },
    timeoutMs: 400,
    run: ({ signal, budgetMs }) => {
      aborted = signal
      budget = budgetMs
      return new Promise(() => {})
    },
  })
  expect(Date.now() - started).toBeLessThan(600)
  expect(result).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
  expect(JSON.stringify(result)).toContain("timeoutMs")
  expect(budget).toBeLessThan(400)
  expect((aborted as AbortSignal | null)?.aborted).toBe(true)
})

test("the engine budget leaves room for its own cause before the tool deadline", async () => {
  const budgets: Array<number> = []
  for (const timeoutMs of [1, 1000, 20000, 30000])
    await withToolDeadline({
      ctx: { signal: new AbortController().signal },
      timeoutMs,
      run: async ({ budgetMs }) => {
        budgets.push(budgetMs)
        return { success: true, content: [] }
      },
    })
  expect(budgets).toEqual([1, 750, 17500, 27500])
})

test("the last failed browser tool of a bot is exposed to the screen viewers", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-failure-"))
  const runtime = createKernel({ appData: root })
  const handlers = new Map<string, ToolRegistration>()
  const register = runtime.kernel.registerTools
  runtime.kernel.registerTools = (input) => {
    for (const tool of input.tools) handlers.set(tool.name, tool)
    return register(input)
  }
  try {
    await init(runtime.kernel)
    const ctx = {
      botId: "bot-1",
      threadId: "t",
      runId: null,
      projectId: null,
      cwd: root,
      signal: new AbortController().signal,
    }
    const failed = await handlers.get("browser_snapshot")?.handler({ ctx, args: { tabId: "t_missing" } })
    expect(failed?.success).toBe(false)
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/browser/tabs?botId=bot-1`, {
      headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
    })
    const body = (await response.json()) as { lastFailure: { tool: string; errorCode: string; error: string } | null }
    expect(body.lastFailure).toMatchObject({
      tool: "browser_snapshot",
      errorCode: failed?.success ? "" : failed?.errorCode,
    })
    expect(body.lastFailure?.error.length).toBeGreaterThan(0)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("VM browser keyboard and mouse tools wait for handback; kill blocks subsequent CDP input", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-handoff-"))
  const runtime = createKernel({ appData: root })
  const handlers = new Map<string, ToolRegistration>()
  const register = runtime.kernel.registerTools
  runtime.kernel.registerTools = (input) => {
    for (const tool of input.tools) handlers.set(tool.name, tool)
    return register(input)
  }
  try {
    await initStore(runtime.kernel)
    await initComputer(runtime.kernel)
    await init(runtime.kernel)
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "handoff-test" },
      body: JSON.stringify({ name: "Tela", provider: "codex", machine: "local" }),
    })
    expect(response.status).toBe(201)
    const { bot } = (await response.json()) as { bot: Bot }
    ;(runtime.kernel.db as import("bun:sqlite").Database)
      .query("UPDATE bots SET machine = 'vm', browser = 'machine' WHERE id = ?")
      .run(bot.id)
    const gate = runtime.kernel.services.use("computer.input")
    if (!gate) throw new Error("Missing input owner")
    const ctx = {
      botId: bot.id,
      threadId: bot.mainThreadId ?? "",
      runId: null,
      projectId: null,
      cwd: root,
      signal: new AbortController().signal,
    }
    await gate.take(bot.id, ctx.signal)
    for (const name of ["browser_click", "browser_type", "browser_press"]) {
      let settled = false
      const pending = handlers
        .get(name)
        ?.handler({ ctx, args: { tabId: "missing" } })
        .then((result) => {
          settled = true
          return result
        })
      await Bun.sleep(10)
      expect(settled).toBe(false)
      gate.handBack(bot.id)
      const result = await pending
      expect(result?.success).toBe(false)
      expect(settled).toBe(true)
      await gate.take(bot.id, ctx.signal)
    }
    gate.kill()
    expect(await handlers.get("browser_type")?.handler({ ctx, args: { tabId: "missing" } })).toMatchObject({
      errorCode: "COMPUTER_KILLED",
    })
  } finally {
    runtime.emitHostNotification({ method: "app.willQuit", params: {} })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
