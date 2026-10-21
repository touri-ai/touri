import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import type { Bot, ToolRegistration } from "@touri/contracts"
import { init, withToolDeadline } from "../../src/browser"
import { createBrowserEngine } from "../../src/browser/engine"
import { init as initComputer } from "../../src/computer"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import "./test-helper"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  const pending = [...cleanups]
  cleanups.clear()
  for (const cleanup of pending) await cleanup()
})

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

test("browser preview stays below 50 ms event-loop lag for 1 Hz maximum-sized frames", async () => {
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
    const response = await request(`/bots/${bot.id}/browser-preview`)
    expect(response.status).toBe(200)
    payloadBytes = (await response.arrayBuffer()).byteLength
    if (sample < 4) await Bun.sleep(1_000)
  }

  delay.disable()
  const maxTickMs = Number((delay.max / 1_000_000).toFixed(2))
  const p99TickMs = Number((delay.percentile(99) / 1_000_000).toFixed(2))
  console.info(
    "[browser-preview sidecar benchmark]",
    JSON.stringify({ samples: previewCount, intervalMs: 1_000, payloadBytes, maxTickMs, p99TickMs }),
  )
  expect(previewCount).toBe(5)
  expect(maxTickMs).toBeLessThan(50)
})

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
