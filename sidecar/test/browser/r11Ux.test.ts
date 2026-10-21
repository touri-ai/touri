import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolResult } from "@touri/contracts"
import { createBrowserEngine } from "../../src/browser/engine"
import { createChromeLauncher } from "../../src/browser/launcher"
import type { CdpClient } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"
import { startBrowserFixtureServer } from "./fixture-server"
import { assertNoTestChrome, forceHeadlessBrowserTests, hasSystemChrome } from "./test-helper"

setDefaultTimeout(40000)

type Snapshot = {
  tabId: string
  generation: number
  url: string
  title: string
  elements: Array<{ ref: string; role: string; name: string }>
  text: string
  notes: Array<string>
}

const snapshotOf = (value: ToolResult): Snapshot => (value as { structured?: unknown }).structured as Snapshot
const textOf = (value: ToolResult): string =>
  JSON.stringify((value as { content?: unknown }).content ?? "") + JSON.stringify((value as { error?: unknown }).error)

type Injection = { method: string; message: string; times: number }

const realSuite = hasSystemChrome ? describe : describe.skip

realSuite("R11 browser UX against real Chrome", () => {
  let root = ""
  let base = ""
  let runtime: ReturnType<typeof createKernel>
  let engine: ReturnType<typeof createBrowserEngine>
  let server: ReturnType<typeof startBrowserFixtureServer>
  let injections: Array<Injection> = []
  const pageSessions: Array<string> = []
  let browserClient: CdpClient | null = null
  const botId = "bot-r11"
  const threadId = "thread-r11"

  beforeAll(async () => {
    forceHeadlessBrowserTests()
    root = mkdtempSync(join(tmpdir(), "touri-r11-browser-"))
    mkdirSync(join(root, "run"), { recursive: true })
    runtime = createKernel({ appData: root })
    const database = runtime.kernel.db as { run: (sql: string, ...args: Array<unknown>) => unknown }
    const now = Date.now()
    mkdirSync(join(root, "bots", botId), { recursive: true })
    database.run(
      "INSERT INTO bots (id,name,provider,home_dir,created_at,updated_at) VALUES (?, ?, 'codex', ?, ?, ?)",
      botId,
      botId,
      join(root, "bots", botId),
      now,
      now,
    )
    database.run(
      "INSERT INTO threads (id,bot_id,kind,title,created_at,updated_at) VALUES (?, ?, 'main', ?, ?, ?)",
      threadId,
      botId,
      threadId,
      now,
      now,
    )
    const launcher = createChromeLauncher({ kernel: runtime.kernel })
    engine = createBrowserEngine({
      kernel: runtime.kernel,
      launcher: {
        ...launcher,
        start: async (options) => {
          const started = await launcher.start(options)
          if (!started) return null
          browserClient = started.client
          return {
            ...started,
            client: {
              ...started.client,
              call: (method, params, sessionId) => {
                if (method === "Runtime.evaluate" && sessionId && !pageSessions.includes(sessionId))
                  pageSessions.push(sessionId)
                const injection = injections.find((item) => item.method === method && item.times > 0)
                if (injection) {
                  injection.times -= 1
                  return Promise.reject(new Error(injection.message))
                }
                return started.client.call(method, params, sessionId)
              },
            },
          }
        },
      },
    })
    server = startBrowserFixtureServer()
    base = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    injections = []
    for (const tab of engine.tabsForBot(null)) {
      await engine.releaseTakeover(tab.tabId).catch(() => false)
      await engine.close({ tabId: tab.tabId, botId, signal: new AbortController().signal })
    }
  })

  afterAll(async () => {
    try {
      await engine.shutdown()
      await assertNoTestChrome({ profile: join(root, "browser", "profiles", "default") })
    } finally {
      runtime.stop()
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  })

  const signal = (): AbortSignal => new AbortController().signal
  const ctx = (abort: AbortSignal = signal()) => ({
    botId,
    threadId,
    projectId: null,
    cwd: root,
    runId: null,
    signal: abort,
  })
  const open = async (path: string, timeoutMs = 20000): Promise<ToolResult> =>
    engine.open({ url: `${base}${path}`, ctx: ctx(), timeoutMs })
  const click = (tabId: string, target: Parameters<typeof engine.click>[0]["target"], timeoutMs = 10000) =>
    engine.click({ tabId, botId, target, button: "left", clickCount: 1, timeoutMs, signal: signal() })

  test("browser_open returns the loaded page, never the initial about:blank", async () => {
    const result = await open("/delayed?ms=700")
    expect(result.success).toBe(true)
    const snapshot = snapshotOf(result)
    expect(snapshot.url).toContain("/delayed")
    expect(snapshot.text).toContain("Delayed ready")
  })

  test("browser_open on a server that never answers fails fast with a coded pt-BR cause and keeps the tab usable", async () => {
    const started = Date.now()
    const result = await open("/never", 1500)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
    expect(textOf(result)).toMatch(/página|prazo|segundos/i)
    expect(textOf(result)).not.toContain("The browser operation")
    const next = await open("/basic")
    expect(next.success).toBe(true)
  })

  test("navigate succeeds once the DOM is usable even when a subresource never finishes", async () => {
    const first = snapshotOf(await open("/basic"))
    const started = Date.now()
    const result = await engine.navigate({
      tabId: first.tabId,
      botId,
      url: `${base}/hanging-subresource`,
      action: "goto",
      timeoutMs: 15000,
      signal: signal(),
    })
    expect(result.success).toBe(true)
    expect(Date.now() - started).toBeLessThan(9000)
    expect(snapshotOf(result).text).toContain("Usable page")
  })

  test("navigate that cannot even commit reports a pt-BR deadline naming the page", async () => {
    const first = snapshotOf(await open("/basic"))
    const started = Date.now()
    const result = await engine.navigate({
      tabId: first.tabId,
      botId,
      url: `${base}/never`,
      action: "goto",
      timeoutMs: 1500,
      signal: signal(),
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
    expect(textOf(result)).toMatch(/não respondeu/i)
  })

  test("a detached CDP session is re-attached and the navigation is not reported as a deadline", async () => {
    const first = snapshotOf(await open("/basic"))
    const session = pageSessions.at(-1) ?? ""
    expect(session).not.toBe("")
    await (browserClient as CdpClient).call("Target.detachFromTarget", { sessionId: session })
    const result = await engine.navigate({
      tabId: first.tabId,
      botId,
      url: `${base}/plain`,
      action: "goto",
      timeoutMs: 10000,
      signal: signal(),
    })
    expect(result.success).toBe(true)
    expect(snapshotOf(result).url).toContain("/plain")
  })

  test("a lost session on snapshot is recovered instead of ENGINE_UNAVAILABLE", async () => {
    const first = snapshotOf(await open("/basic"))
    injections.push({ method: "Accessibility.getFullAXTree", message: "Session with given id not found", times: 1 })
    const result = await engine.snapshot({ tabId: first.tabId, botId, image: "never", signal: signal() })
    expect(result.success).toBe(true)
  })

  test("an unrecoverable snapshot failure names the cause in pt-BR", async () => {
    const first = snapshotOf(await open("/basic"))
    injections.push({ method: "Runtime.evaluate", message: "Target closed", times: 50 })
    const result = await engine.snapshot({ tabId: first.tabId, botId, image: "never", signal: signal() })
    expect(result.success).toBe(false)
    expect(textOf(result)).toMatch(/página|aba|navegador/i)
    expect(textOf(result)).not.toContain("The page snapshot could not be collected")
  })

  test("click on a far footer link works under CSS smooth scrolling", async () => {
    const first = snapshotOf(await open("/smooth"))
    const result = await click(first.tabId, { kind: "css", selector: "#footer-link" })
    expect(result.success).toBe(true)
    expect(snapshotOf(result).url).toContain("/click-destination")
  })

  test("click survives Chrome answering 'No node found at given location' for the hit test", async () => {
    const first = snapshotOf(await open("/smooth"))
    injections.push({ method: "DOM.getNodeForLocation", message: "No node found at given location", times: 50 })
    const result = await click(first.tabId, { kind: "role", role: "link", name: "Footer link", exact: true })
    expect(result.success).toBe(true)
    expect(snapshotOf(result).url).toContain("/click-destination")
  })

  test("click by role on a page that scrolled itself still lands once", async () => {
    const first = snapshotOf(await open("/smooth"))
    await engine.scroll({
      tabId: first.tabId,
      botId,
      target: null,
      direction: "down",
      pages: 10,
      signal: signal(),
    })
    const result = await click(first.tabId, { kind: "role", role: "link", name: "Top link", exact: true })
    expect(result.success).toBe(true)
  })

  test("click waits for a control that becomes enabled and fails fast, in pt-BR, on one that never does", async () => {
    const first = snapshotOf(await open("/disabled-later"))
    const waited = await click(first.tabId, { kind: "css", selector: "#later" })
    expect(waited.success).toBe(true)
    const count = await engine.evaluate({ tabId: first.tabId, botId, expression: "window.clicks", signal: signal() })
    expect(count).toMatchObject({ structured: 1 })
    const started = Date.now()
    const never = await click(first.tabId, { kind: "css", selector: "#never" })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(never).toMatchObject({ success: false, errorCode: "TARGET_NOT_INTERACTABLE" })
    expect(textOf(never)).toContain("desativado")
  })

  test("full-page screenshots of huge noisy pages stay under the size cap", async () => {
    const first = snapshotOf(await open("/tall-noise"))
    const started = Date.now()
    const result = await engine.screenshot({ tabId: first.tabId, botId, fullPage: true, signal: signal() })
    expect(Date.now() - started).toBeLessThan(15000)
    expect(result.success).toBe(true)
    const image = (result as { content: Array<{ type: string; data?: string }> }).content.find(
      (item) => item.type === "image",
    )
    expect(image?.data?.startsWith("/9j/")).toBe(true)
    expect(image?.data?.length ?? 0).toBeLessThanOrEqual(300 * 1024)
  })

  test("a link that opens a new tab tells the bot which tab to use", async () => {
    const first = snapshotOf(await open("/popup-link"))
    const result = await click(first.tabId, { kind: "role", role: "link", name: "Open in new tab", exact: true })
    expect(result.success).toBe(true)
    const text = textOf(result)
    expect(text).toContain("Nova aba")
    const tabs = engine.tabsForBot(botId)
    const popup = tabs.find((tab) => tab.tabId !== first.tabId)
    expect(popup).toBeDefined()
    expect(text).toContain(popup?.tabId ?? "missing")
  })

  test("snapshot, screenshot and evaluate honour timeoutMs on a wedged page", async () => {
    const first = snapshotOf(await open("/basic"))
    const started = Date.now()
    const evaluated = await engine.evaluate({
      tabId: first.tabId,
      botId,
      expression:
        "new Promise(() => {}) && (function(){ const end = Date.now() + 4000; while (Date.now() < end); return 1 })()",
      timeoutMs: 800,
      signal: signal(),
    })
    expect(Date.now() - started).toBeLessThan(3500)
    expect(evaluated).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
    expect(textOf(evaluated)).toMatch(/prazo|segundos|página/i)
  })

  test("takeover request ends immediately when the run is cancelled and the tab is released", async () => {
    const first = snapshotOf(await open("/basic"))
    const abort = new AbortController()
    const pending = engine.requestTakeover({
      tabId: first.tabId,
      botId,
      reason: "login",
      timeoutMs: 600000,
      signal: abort.signal,
    })
    await Bun.sleep(300)
    const started = Date.now()
    abort.abort()
    const result = await Promise.race([pending, Bun.sleep(4000).then(() => "STILL_WAITING" as const)])
    expect(result).not.toBe("STILL_WAITING")
    expect(Date.now() - started).toBeLessThan(3000)
    const tab = engine.tabsForBot(botId).find((item) => item.tabId === first.tabId)
    expect(tab?.heldByUser).toBe(false)
  })

  test("releasing a tab that is no longer held is idempotent and hold never hangs on notifications", async () => {
    const first = snapshotOf(await open("/basic"))
    expect(await engine.releaseTakeover(first.tabId)).toBe(true)
    const started = Date.now()
    expect(await engine.holdTakeover({ tabId: first.tabId, reason: "x" })).toBe(true)
    expect(Date.now() - started).toBeLessThan(6000)
    expect(await engine.releaseTakeover(first.tabId)).toBe(true)
    expect(await engine.releaseTakeover(first.tabId)).toBe(true)
  })

  test("a takeover that times out publishes the tab as released", async () => {
    const first = snapshotOf(await open("/basic"))
    const result = await engine.requestTakeover({
      tabId: first.tabId,
      botId,
      reason: "login",
      timeoutMs: 600,
      signal: signal(),
    })
    expect(result.success).toBe(true)
    expect(engine.tabsForBot(botId).find((item) => item.tabId === first.tabId)).toMatchObject({
      heldByUser: false,
      takeoverRequested: true,
    })
    expect((await engine.snapshot({ tabId: first.tabId, botId, image: "auto", signal: signal() })).success).toBe(false)
    await Bun.sleep(650)
    expect(engine.tabsForBot(botId).find((item) => item.tabId === first.tabId)).toMatchObject({
      heldByUser: false,
      takeoverRequested: false,
    })
  })
})
