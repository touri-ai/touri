import { afterEach, expect, mock, test } from "bun:test"
import type { Bot, ToolContext, ToolRegistration } from "@touri/contracts"
import { createBrowserEngine } from "../../src/browser/engine"
import type { CdpClient, CdpEvent, JsonObject } from "../../src/browser/types"
import type { McpCallerContext } from "../../src/mcp/auth"
import { createToolRouter } from "../../src/mcp/router"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const resources = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of resources) await close()
  resources.clear()
})

const getFixture = async (idleMs = 300_000) => {
  const f = testKernel()
  await initStore(f.kernel)
  const { bot } = (await f.request("POST /bots", { name: "Browser fixture", provider: "codex" })).json as { bot: Bot }
  const calls: Array<{ method: string; params: JsonObject }> = []
  const listeners = new Set<(event: CdpEvent) => void>()
  // The fake models the external CDP server's mutable state, isolated to each fixture.
  const state = { target: 0, slowAx: false, loading: false, dns: false, hangEvaluation: false, crashes: 0 }
  const blocked = Promise.withResolvers<void>()
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}) => {
      calls.push({ method, params })
      if (state.hangEvaluation && method === "Runtime.evaluate") {
        blocked.resolve()
        return new Promise<T>(() => {})
      }
      if (state.crashes > 0 && method === "Page.enable") {
        state.crashes -= 1
        for (const listener of listeners)
          listener({ method: "Target.targetCrashed", params: { targetId: `target-${state.target}`, status: "oom" } })
      }
      if (state.slowAx && method === "Accessibility.getFullAXTree") return new Promise<T>(() => {})
      if (method === "Target.createBrowserContext") return { browserContextId: "isolated" } as T
      if (method === "Target.createTarget") return { targetId: `target-${++state.target}` } as T
      if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` } as T
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: {
              url: "https://example.test/",
              href: state.dns ? "chrome-error://chromewebdata/" : "https://example.test/",
              title: "Synthetic page",
              readyState: state.loading ? "loading" : "complete",
              loading: state.loading,
              text: state.dns ? "ERR_NAME_NOT_RESOLVED" : "Useful partial content",
              frames: [],
              challengeElements: [],
              mutationVersion: 0,
              active: { role: "", name: "", backendNodeId: null },
              viewport: { width: 800, height: 600, scrollY: 0, scrollHeight: 600 },
              hasCanvas: false,
              hasVideo: false,
              crossOriginIframe: false,
            },
          },
        } as T
      return {} as T
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: async () => {},
    isClosed: () => false,
  }
  const launch = Promise.withResolvers<void>()
  const launchStarted = Promise.withResolvers<void>()
  const start = mock(async () => {
    launchStarted.resolve()
    await launch.promise
    return { client }
  })
  const stop = mock(async () => {})
  const engine = createBrowserEngine({ kernel: f.kernel, launcher: { start, stop }, idleMs, snapshotBudgetMs: 60 })
  resources.add(async () => {
    await engine.shutdown()
    f.close()
  })
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    runId: null,
    projectId: null,
    cwd: f.kernel.paths.appData,
    signal: new AbortController().signal,
  }

  return { f, bot, ctx, engine, launch, launchStarted, start, stop, calls, state, listeners, blocked }
}

test("unsupported host screen tools are neither listed nor callable despite a saved enabled flag", async () => {
  if (process.platform === "darwin") return
  const { f, bot, ctx } = await getFixture()
  const handler = mock(async () => ({ success: true as const, content: [] }))
  const registration: ToolRegistration = { name: "computer_screenshot", group: "computer", handler }
  const router = createToolRouter({ kernel: f.kernel, registrations: new Map([[registration.name, registration]]) })
  const caller: McpCallerContext = Object.assign({}, ctx, {
    provider: bot.provider,
    browserEnabled: true,
    computerUse: true,
  })

  const listed = router.list({ caller })
  const result = await router.call({ id: 1, name: "computer_screenshot", args: {}, caller, signal: ctx.signal })

  expect(listed).toEqual([])
  expect(JSON.stringify(result)).toContain("TOOL_NOT_FOUND")
  expect(handler).not.toHaveBeenCalled()
})

test("simultaneous tabs share one browser startup and enforce the per-bot limit", async () => {
  const f = await getFixture()
  const opened = Array.from({ length: 9 }, () => f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 }))
  f.launch.resolve()

  const results = await Promise.all(opened)

  expect(f.start).toHaveBeenCalledTimes(1)
  expect(results.filter((result) => result.success)).toHaveLength(8)
  expect(results[8]).toMatchObject({ success: false, errorCode: "TAB_LIMIT" })
})

test("slow accessibility reads return fresh partial text within a bounded budget", async () => {
  const f = await getFixture()
  f.launch.resolve()
  await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 })
  const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId ?? ""
  f.state.slowAx = true

  const started = performance.now()
  const result = await f.engine.snapshot({
    tabId,
    botId: f.bot.id,
    signal: f.ctx.signal,
    image: "never",
    timeoutMs: 60_000,
  })

  expect(result).toMatchObject({ success: true, structured: { text: "Useful partial content", truncated: true } })
  expect(performance.now() - started).toBeLessThan(2000)
  expect(f.calls.some((call) => call.method === "Runtime.terminateExecution")).toBe(true)
})

test("cancelling one caller does not cancel another caller sharing browser startup", async () => {
  const f = await getFixture()
  const controller = new AbortController()
  const first = f.engine.open({
    url: "about:blank",
    ctx: Object.assign({}, f.ctx, { signal: controller.signal }),
    timeoutMs: 2500,
  })
  const second = f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 })
  await f.launchStarted.promise

  controller.abort()
  f.launch.resolve()
  const results = await Promise.all([first, second])

  expect(results[0]).toMatchObject({ success: false })
  expect(results[1]).toMatchObject({ success: true })
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.stop).not.toHaveBeenCalled()
})

test("failed DNS navigation retries exactly once and preserves its cause", async () => {
  const f = await getFixture()
  f.launch.resolve()
  f.state.dns = true

  const result = await f.engine.open({ url: "https://example.test/", ctx: f.ctx, timeoutMs: 2000 })

  expect(result).toMatchObject({ success: false, errorCode: "NAVIGATION_FAILED" })
  expect(JSON.stringify(result)).toContain("ERR_NAME_NOT_RESOLVED")
  expect(f.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(1)
})

test("a loading page times out after one retry instead of pretending the blank tab loaded", async () => {
  const f = await getFixture()
  f.launch.resolve()
  f.state.loading = true

  const started = performance.now()
  const result = await f.engine.open({ url: "https://example.test/", ctx: f.ctx, timeoutMs: 1000 })

  expect(result).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
  expect(performance.now() - started).toBeLessThan(2000)
  expect(f.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(1)
})

test("an idle managed browser is stopped automatically and its tabs can be reopened", async () => {
  const f = await getFixture(80)
  f.launch.resolve()
  await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 })

  await new Promise<void>((resolve, reject) => {
    const limit = setTimeout(() => reject(new Error("Browser was not reclaimed")), 3000)
    f.stop.mockImplementation(async () => {
      clearTimeout(limit)
      resolve()
    })
  })

  expect(f.engine.tabsForBot(f.bot.id)[0]?.state).toBe("unloaded")
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect((await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 })).success).toBe(true)
  expect(f.start).toHaveBeenCalledTimes(2)
})

test("a renderer that runs out of memory is retried once and reports its cause", async () => {
  const f = await getFixture()
  f.launch.resolve()
  f.state.crashes = 2

  const result = await f.engine.open({ url: "https://example.test/", ctx: f.ctx, timeoutMs: 2500 })

  expect(result).toMatchObject({ success: false, errorCode: "ENGINE_UNAVAILABLE" })
  expect(JSON.stringify(result)).toContain("falta de memória")
  expect(f.calls.filter((call) => call.method === "Target.createTarget")).toHaveLength(2)
  expect(f.calls.filter((call) => call.method === "Target.closeTarget")).toHaveLength(1)
})

test("snapshot deadline includes waiting behind an earlier operation in the same tab", async () => {
  const f = await getFixture()
  f.launch.resolve()
  await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 })
  const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId ?? ""
  f.state.hangEvaluation = true
  const controller = new AbortController()
  const previous = f.engine.evaluate({
    tabId,
    botId: f.bot.id,
    expression: "document.title",
    signal: controller.signal,
    timeoutMs: 5000,
  })
  await f.blocked.promise

  const started = performance.now()
  const result = await f.engine.snapshot({
    tabId,
    botId: f.bot.id,
    image: "never",
    signal: f.ctx.signal,
    timeoutMs: 20,
  })
  controller.abort()
  await previous

  expect(result).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
  expect(performance.now() - started).toBeLessThan(2500)
})

test("navigation of an existing tab also retries once and preserves a DNS failure", async () => {
  const f = await getFixture()
  f.launch.resolve()
  await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 2500 })
  const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId ?? ""
  f.state.dns = true

  const result = await f.engine.navigate({
    tabId,
    botId: f.bot.id,
    url: "https://example.test/",
    action: "goto",
    timeoutMs: 2000,
    signal: f.ctx.signal,
  })

  expect(result).toMatchObject({ success: false, errorCode: "NAVIGATION_FAILED" })
  expect(JSON.stringify(result)).toContain("ERR_NAME_NOT_RESOLVED")
  expect(f.calls.filter((call) => call.method === "Page.navigate")).toHaveLength(2)
})
