import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, ToolRegistration } from "@touri/contracts"
import { init, withToolDeadline } from "../../src/browser"
import { createBrowserEngine } from "../../src/browser/engine"
import type { BrowserEngine } from "../../src/browser/types"
import { init as initComputer } from "../../src/computer"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import "./test-helper"

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

test("a local owner can return browser control without a paired work identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-takeover-owner-"))
  const runtime = createKernel({ appData: root })
  const people: string[] = []
  const engine: BrowserEngine = {
    ...createBrowserEngine({ kernel: runtime.kernel }),
    tabsForBot: () => [],
    releaseTakeoverForPerson: async ({ personId }: { personId: string }) => {
      people.push(personId)
      return "released"
    },
  }
  try {
    await init(runtime.kernel, undefined, { engine })
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/browser/tabs/tab-1/takeover`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hold: false }),
    })
    expect(response.status).toBe(200)
    expect(people).toEqual(["owner"])
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

test("browser takeover enforces a two-minute minimum and a thirty-minute maximum", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-takeover-timeout-"))
  const runtime = createKernel({ appData: root })
  const handlers = new Map<string, ToolRegistration>()
  const durations: number[] = []
  runtime.kernel.registerTools = ({ tools }) => {
    for (const item of tools) handlers.set(item.name, item)
    return { success: true, count: tools.length }
  }
  const engine: BrowserEngine = {
    ...createBrowserEngine({ kernel: runtime.kernel }),
    requestTakeover: async ({ timeoutMs }: { timeoutMs: number }) => {
      durations.push(timeoutMs)
      return { success: true, content: [] }
    },
    tabsForBot: () => [],
  }
  try {
    await init(runtime.kernel, undefined, { engine })
    const handler = handlers.get("browser_request_takeover")?.handler
    if (!handler) throw new Error("Missing browser takeover tool")
    const ctx = {
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      projectId: null,
      cwd: root,
      signal: new AbortController().signal,
    }
    await handler({ ctx, args: { tabId: "tab-1", timeoutMs: 5000 } })
    await handler({ ctx, args: { tabId: "tab-1", timeoutMs: 3600000 } })
    expect(durations).toEqual([120000, 1800000])
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
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
