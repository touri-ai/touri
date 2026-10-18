import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server as NetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostMethods } from "@touri/contracts"
import { createBrowserEngine, withDeadline } from "../../src/browser/engine"
import {
  createChromeLauncher,
  deriveChromeLaunchArgs,
  deriveChromePortLaunchArgs,
  deriveChromeWindowArgs,
  deriveChromeWindowConfig,
  downloadChromeForTesting,
  parseDevToolsActivePort,
} from "../../src/browser/launcher"
import { createKernel } from "../../src/kernel"
import { createFakeHost } from "../fakes/fakeHost"
import { startBrowserFixtureServer } from "./fixture-server"
import {
  assertHeadlessLaunchArgs,
  assertNoTestChrome,
  forceHeadlessBrowserTests,
  hasSystemChrome,
  systemChromePath,
} from "./test-helper"

if (!hasSystemChrome)
  console.warn("WP6 browser acceptance tests skipped: /Applications/Google Chrome.app was not found")
setDefaultTimeout(30000)

type Snapshot = {
  tabId: string
  generation: number
  url: string
  elements: Array<{ ref: string; role: string; name: string; value?: string; frame: string }>
  text: string
  truncated: boolean
  diagnostics: Array<{ text: string }>
  recentActions: Array<unknown>
  image: { dataUrl: string } | null
  recommendImage: string | null
  notes: Array<string>
}

type ToolOkValue = { structured?: unknown }

const snapshotOf = (value: unknown): Snapshot => (value as ToolOkValue).structured as Snapshot

const fakeHostServer = async ({
  socketPath,
}: {
  socketPath: string
}): Promise<{ server: NetServer; fake: ReturnType<typeof createFakeHost> }> => {
  const fake = createFakeHost()
  fake.methods["secret.prompt"] = async () => ({
    values: { password: "hunter2-secret", username: "hunter2-secret", otp: "hunter2-secret" },
  })
  const server = createServer((socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (!line) continue
        void (async () => {
          const request = JSON.parse(line) as { id: number; method: string; params: unknown }
          let result: unknown = {}
          if (request.method === "auth") result = { ok: true }
          else if (request.method === "secret.prompt")
            result = await fake.methods["secret.prompt"](request.params as HostMethods["secret.prompt"]["params"])
          else if (request.method === "keychain.get")
            result = await fake.methods["keychain.get"](request.params as HostMethods["keychain.get"]["params"])
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
        })()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { server, fake }
}

const insertOwner = (
  kernel: ReturnType<typeof createKernel>["kernel"],
  root: string,
  botId: string,
  threadId: string,
): void => {
  const database = kernel.db as { run: (sql: string, ...args: Array<unknown>) => unknown }
  const now = Date.now()
  database.run(
    "INSERT INTO bots (id,name,provider,home_dir,created_at,updated_at) VALUES (?, ?, 'codex', ?, ?, ?)",
    botId,
    botId,
    join(root, "bots", botId),
    now,
    now,
  )
  mkdirSync(join(root, "bots", botId), { recursive: true })
  database.run(
    "INSERT INTO threads (id,bot_id,kind,title,created_at,updated_at) VALUES (?, ?, 'main', ?, ?, ?)",
    threadId,
    botId,
    threadId,
    now,
    now,
  )
}

const realSuite = hasSystemChrome ? describe : describe.skip

realSuite("WP6 real Chrome browser acceptance", () => {
  let root = ""
  let base = ""
  let runtime: ReturnType<typeof createKernel>
  let engine: ReturnType<typeof createBrowserEngine>
  let server: ReturnType<typeof startBrowserFixtureServer>
  let host: NetServer
  let originalHostSocket: string | undefined
  let originalWindowPosition: string | undefined
  let originalWindowSize: string | undefined
  let chromeLaunchArgs: Array<string> = []
  let failHitTest = false
  let nodeInspectionCalls = 0
  const botA = "bot-browser-a"
  const botB = "bot-browser-b"
  const threadA = "thread-browser-a"
  const threadB = "thread-browser-b"

  beforeAll(async () => {
    forceHeadlessBrowserTests()
    root = mkdtempSync(join(tmpdir(), "touri-wp6-browser-"))
    mkdirSync(join(root, "run"), { recursive: true })
    originalHostSocket = process.env.TOURI_HOST_SOCK
    originalWindowPosition = process.env.TOURI_BROWSER_WINDOW_POSITION
    originalWindowSize = process.env.TOURI_BROWSER_WINDOW_SIZE
    process.env.TOURI_BROWSER_WINDOW_POSITION = "-1920,-251"
    process.env.TOURI_BROWSER_WINDOW_SIZE = "1920,1080"
    const fake = await fakeHostServer({ socketPath: join(root, "run", "host.sock") })
    host = fake.server
    process.env.TOURI_HOST_SOCK = join(root, "run", "host.sock")
    runtime = createKernel({ appData: root })
    const spawnTree = runtime.kernel.spawnTree
    runtime.kernel.spawnTree = (input) => {
      if (input.cmd === systemChromePath) chromeLaunchArgs = [...input.args]
      return spawnTree(input)
    }
    insertOwner(runtime.kernel, root, botA, threadA)
    insertOwner(runtime.kernel, root, botB, threadB)
    const launcher = createChromeLauncher({ kernel: runtime.kernel })
    engine = createBrowserEngine({
      kernel: runtime.kernel,
      launcher: {
        ...launcher,
        start: async (options) => {
          const started = await launcher.start(options)
          if (!started) return null
          return {
            ...started,
            client: {
              ...started.client,
              call: (method, ...args) => {
                if (["DOM.getBoxModel", "DOM.describeNode"].includes(method)) nodeInspectionCalls += 1
                if (failHitTest && ["DOM.getNodeForLocation", "DOM.scrollIntoViewIfNeeded"].includes(method))
                  return Promise.reject(new Error("fixture CDP locator unavailable"))
                return started.client.call(method, ...args)
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
    failHitTest = false
    for (const tab of engine.tabsForBot(null)) {
      const signal = new AbortController().signal
      const closed = await engine.close({ tabId: tab.tabId, botId: botA, signal })
      if (!closed.success) await engine.close({ tabId: tab.tabId, botId: botB, signal })
    }
  })

  afterAll(async () => {
    try {
      await engine.shutdown()
      await assertNoTestChrome({ profile: join(root, "browser", "profiles", "default") })
    } finally {
      runtime.stop()
      server.stop(true)
      await new Promise<void>((resolve) => host.close(() => resolve()))
      if (originalHostSocket === undefined) delete process.env.TOURI_HOST_SOCK
      else process.env.TOURI_HOST_SOCK = originalHostSocket
      if (originalWindowPosition === undefined) delete process.env.TOURI_BROWSER_WINDOW_POSITION
      else process.env.TOURI_BROWSER_WINDOW_POSITION = originalWindowPosition
      if (originalWindowSize === undefined) delete process.env.TOURI_BROWSER_WINDOW_SIZE
      else process.env.TOURI_BROWSER_WINDOW_SIZE = originalWindowSize
      rmSync(root, { recursive: true, force: true })
    }
  })

  const ctx = (botId = botA, threadId = threadA) => ({
    botId,
    threadId,
    projectId: null,
    cwd: root,
    runId: null,
    signal: new AbortController().signal,
  })
  const open = async (path: string, botId = botA, threadId = threadA): Promise<Snapshot> => {
    const result = await engine.open({ url: `${base}${path}`, ctx: ctx(botId, threadId), timeoutMs: 20000 })
    if (!result.success) throw new Error(JSON.stringify(result))
    expect(result.success).toBe(true)
    assertHeadlessLaunchArgs({ args: chromeLaunchArgs })
    return snapshotOf(result)
  }

  test("R1 fresh snapshot, R2 stale refs and target changes", async () => {
    const before = await open("/basic")
    const clicked = await engine.click({
      tabId: before.tabId,
      botId: botA,
      target: { kind: "ref", ref: before.elements.at(0)?.ref ?? "" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(clicked.success).toBe(true)
    const after = snapshotOf(clicked)
    expect(after.generation).toBeGreaterThan(before.generation)
    const stale = await engine.click({
      tabId: before.tabId,
      botId: botA,
      target: { kind: "ref", ref: before.elements.at(0)?.ref ?? "" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(stale.success).toBe(true)
    const current = await engine.snapshot({ tabId: before.tabId, botId: botA, image: "never", signal: ctx().signal })
    const currentSnapshot = snapshotOf(current)
    await engine.evaluate({
      tabId: before.tabId,
      botId: botA,
      expression: "document.querySelector('#save').textContent='Different'",
      signal: ctx().signal,
    })
    const changed = await engine.click({
      tabId: before.tabId,
      botId: botA,
      target: { kind: "ref", ref: currentSnapshot.elements.at(0)?.ref ?? "" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(changed).toMatchObject({ success: false, errorCode: "TARGET_CHANGED" })
    const navigation = await engine.open({ url: `${base}/navigate-timer`, ctx: ctx(), timeoutMs: 10000 })
    if (!navigation.success) expect(navigation).toMatchObject({ errorCode: "NAVIGATED_DURING_SNAPSHOT" })
    else {
      const navigated = snapshotOf(navigation)
      expect(navigated.url).toContain("/basic")
      expect(navigated.text).not.toContain("Before navigation")
    }
  })

  test("R9 links with AX names survive DOM replacement, scroll, use verified coordinates and navigate once", async () => {
    const before = await open("/mutating-link")
    const ref = before.elements.find((element) => element.name === "Go to destination")?.ref ?? ""
    expect(ref).not.toBe("")
    await engine.evaluate({
      tabId: before.tabId,
      botId: botA,
      expression: "window.replaceLink()",
      signal: ctx().signal,
    })
    const click = (target: { kind: "ref"; ref: string } | { kind: "css"; selector: string }) =>
      engine.click({
        tabId: before.tabId,
        botId: botA,
        target,
        button: "left",
        clickCount: 1,
        timeoutMs: 10000,
        signal: ctx().signal,
      })
    failHitTest = true
    const fallback = await click({ kind: "ref", ref })
    expect(fallback).toMatchObject({ success: true })
    expect(snapshotOf(fallback).url).toContain("/click-destination")
    const clicks = () =>
      engine.evaluate({
        tabId: before.tabId,
        botId: botA,
        expression: "Number(localStorage.getItem('r9ClickCount'))",
        signal: ctx().signal,
      })
    expect((await clicks()) as { structured: number }).toMatchObject({ structured: 1 })
    expect(
      snapshotOf(fallback).recentActions.filter(
        (action) =>
          (action as { tool: string; ok: boolean }).tool === "browser_click" && (action as { ok: boolean }).ok,
      ),
    ).toHaveLength(1)
    failHitTest = false
    // A retained link ref can be resolved on the new document using its identity.
    expect((await click({ kind: "ref", ref })).success).toBe(true)
    const below = await click({ kind: "css", selector: "#below-fold" })
    expect(below).toMatchObject({ success: true })
    expect(snapshotOf(below).url).toContain("/click-destination")
    expect((await clicks()) as { structured: number }).toMatchObject({ structured: 3 })
  })

  test("P2-2 close returns an explicit terminal tab state", async () => {
    const tab = await open("/basic")
    const closed = await engine.close({ tabId: tab.tabId, botId: botA, signal: ctx().signal })
    expect(closed).toMatchObject({ success: true, structured: { tabId: tab.tabId, state: "closed", closed: true } })
    expect(JSON.stringify(closed)).not.toContain('"state":"live"')
  })

  test("R3 resolution ambiguity and missing targets", async () => {
    const snapshot = await open("/ambiguous")
    const ambiguous = await engine.click({
      tabId: snapshot.tabId,
      botId: botA,
      target: { kind: "role", role: "button", name: "Save" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(ambiguous).toMatchObject({ success: false, errorCode: "AMBIGUOUS_TARGET" })
    if (!ambiguous.success) {
      expect(ambiguous.error).toContain("Save")
      expect(ambiguous.error).toMatch(/\d+\.0/)
    }
    const missing = await engine.click({
      tabId: snapshot.tabId,
      botId: botA,
      target: { kind: "css", selector: ".missing" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(missing).toMatchObject({ success: false, errorCode: "TARGET_NOT_FOUND" })
  })

  test("R4 hit testing rejects an overlay and accepts after Escape", async () => {
    const snapshot = await open("/overlay")
    const covered = await engine.click({
      tabId: snapshot.tabId,
      botId: botA,
      target: { kind: "role", role: "button", name: "Save" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(covered).toMatchObject({ success: false, errorCode: "TARGET_COVERED" })
    if (!covered.success) expect(covered.error).toContain("dialog")
    const dismissed = await engine.press({
      tabId: snapshot.tabId,
      botId: botA,
      key: "Escape",
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(dismissed.success).toBe(true)
    const after = snapshotOf(dismissed)
    const clicked = await engine.click({
      tabId: snapshot.tabId,
      botId: botA,
      target: { kind: "ref", ref: after.elements.at(0)?.ref ?? "" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(clicked.success).toBe(true)
    const partial = await open("/partial")
    const partialClick = await engine.click({
      tabId: partial.tabId,
      botId: botA,
      target: { kind: "role", role: "button", name: "Partially covered", exact: true },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(partialClick.success).toBe(true)
  })

  test("P1-9/P1-10 resolve same-origin, OOPIF, shadow and native controls", async () => {
    const frames = await open("/frames")
    expect(frames.text).toContain("Same frame")
    expect(frames.text).toContain("Cross frame")
    expect(frames.elements.some((element) => element.name === "Cross frame" && element.frame !== "")).toBe(true)
    const cross = await engine.click({
      tabId: frames.tabId,
      botId: botA,
      target: { kind: "css", selector: "#cross-frame-target" },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(cross.success).toBe(true)

    const shadow = await open("/shadow")
    const shadowClick = await engine.click({
      tabId: shadow.tabId,
      botId: botA,
      target: { kind: "role", role: "button", name: "Shadow save", exact: true },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(shadowClick.success).toBe(true)
    const native = await engine.click({
      tabId: shadow.tabId,
      botId: botA,
      target: { kind: "role", role: "slider", name: "Native range", exact: true },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(native.success).toBe(true)
  })

  test("R5 snapshot caps and conditional images", async () => {
    nodeInspectionCalls = 0
    const large = await open("/large")
    expect(large.elements.length).toBe(200)
    expect(large.truncated).toBe(true)
    expect(nodeInspectionCalls).toBeLessThanOrEqual(400)
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThanOrEqual(128 * 1024)
    const canvas = await open("/canvas")
    expect(canvas.recommendImage).toBe("canvas-or-video")
    expect(canvas.image).not.toBeNull()
    const plain = await open("/plain")
    expect(plain.image).toBeNull()
    const huge = await open("/huge")
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeLessThanOrEqual(128 * 1024)
  })

  test("R6 action and diagnostic rings are bounded", async () => {
    let snapshot = await open("/basic")
    for (let index = 0; index < 12; index += 1) {
      const result = await engine.press({
        tabId: snapshot.tabId,
        botId: botA,
        key: "Enter",
        timeoutMs: 10000,
        signal: ctx().signal,
      })
      expect(result.success).toBe(true)
      snapshot = snapshotOf(result)
    }
    expect(snapshot.recentActions).toHaveLength(10)
    await engine.evaluate({
      tabId: snapshot.tabId,
      botId: botA,
      expression: "console.error('fixture console error')",
      signal: ctx().signal,
    })
    await Bun.sleep(100)
    const diagnostic = await engine.snapshot({
      tabId: snapshot.tabId,
      botId: botA,
      image: "never",
      signal: ctx().signal,
    })
    expect(snapshotOf(diagnostic).diagnostics.some((item) => item.text.includes("fixture console error"))).toBe(true)
  })

  test("R7 serializes operations and releases a timed-out wait", async () => {
    const snapshot = await open("/basic")
    const [first, second] = await Promise.all([
      engine.press({ tabId: snapshot.tabId, botId: botA, key: "Enter", timeoutMs: 10000, signal: ctx().signal }),
      engine.press({ tabId: snapshot.tabId, botId: botA, key: "Enter", timeoutMs: 10000, signal: ctx().signal }),
    ])
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    const timedOut = await engine.waitFor({
      tabId: snapshot.tabId,
      botId: botA,
      condition: { text: "never appears" },
      timeoutMs: 500,
      signal: ctx().signal,
    })
    expect(timedOut).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
    expect(
      (await engine.snapshot({ tabId: snapshot.tabId, botId: botA, image: "never", signal: ctx().signal })).success,
    ).toBe(true)
    const ordering = await open("/ordering")
    const [orderedFirst, orderedSecond] = await Promise.all([
      engine.click({
        tabId: ordering.tabId,
        botId: botA,
        target: { kind: "role", role: "button", name: "Order", exact: true },
        button: "left",
        clickCount: 1,
        timeoutMs: 10000,
        signal: ctx().signal,
      }),
      engine.click({
        tabId: ordering.tabId,
        botId: botA,
        target: { kind: "role", role: "button", name: "Order", exact: true },
        button: "left",
        clickCount: 1,
        timeoutMs: 10000,
        signal: ctx().signal,
      }),
    ])
    expect(orderedFirst.success).toBe(true)
    expect(orderedSecond.success).toBe(true)
    const order = await engine.evaluate({
      tabId: ordering.tabId,
      botId: botA,
      expression: "window.order",
      signal: ctx().signal,
    })
    expect(order.success).toBe(true)
    if (order.success) {
      const entries = order.structured as Array<{ index: number; at: number }>
      expect(entries.map((entry) => entry.index)).toEqual([0, 1])
      expect(entries.every((entry) => typeof entry.at === "number")).toBe(true)
    }
  })

  test("R8 takeover blocks tools and hand-back bumps generation", async () => {
    const snapshot = await open("/basic")
    expect(await engine.holdTakeover({ tabId: snapshot.tabId, reason: "fixture" })).toBe(true)
    expect(
      await engine.snapshot({ tabId: snapshot.tabId, botId: botA, image: "never", signal: ctx().signal }),
    ).toMatchObject({ success: false, errorCode: "TAB_HELD_BY_USER" })
    expect(await engine.releaseTakeover(snapshot.tabId)).toBe(true)
    const returned = await engine.snapshot({ tabId: snapshot.tabId, botId: botA, image: "never", signal: ctx().signal })
    expect(returned.success).toBe(true)
    const after = snapshotOf(returned)
    expect(after.generation).toBeGreaterThan(snapshot.generation)
    expect(after.notes).toContain("User handed back the tab; the page may have changed.")
  })

  test("R9 secure secret entry never exposes the value", async () => {
    const snapshot = await open("/secret")
    const result = await engine.submitSecret({
      tabId: snapshot.tabId,
      botId: botA,
      threadId: threadA,
      projectId: null,
      fields: [{ kind: "password", target: { kind: "role", role: "textbox", name: "Password", exact: true } }],
      submit: "none",
      signal: ctx().signal,
    })
    expect(result.success).toBe(true)
    if (result.success)
      expect(snapshotOf(result).elements.find((element) => element.name === "Password")?.value).toBeUndefined()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("hunter2")
    expect(
      await engine.screenshot({ tabId: snapshot.tabId, botId: botA, fullPage: false, signal: ctx().signal }),
    ).toMatchObject({ success: false, errorCode: "SECRET_ENTRY_ACTIVE" })
    expect(
      await engine.evaluate({
        tabId: snapshot.tabId,
        botId: botA,
        expression: "document.querySelector('#password').value",
        signal: ctx().signal,
      }),
    ).toMatchObject({ success: false, errorCode: "SECRET_ENTRY_ACTIVE" })
    const navigated = await engine.navigate({
      tabId: snapshot.tabId,
      botId: botA,
      url: `${base}/secret`,
      action: "goto",
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(navigated.success).toBe(true)
    const submitted = await engine.submitSecret({
      tabId: snapshot.tabId,
      botId: botA,
      threadId: threadA,
      projectId: null,
      fields: [{ kind: "password", target: { kind: "role", role: "textbox", name: "Password", exact: true } }],
      submit: "click",
      submitTarget: { kind: "role", role: "button", name: "Submit", exact: true },
      signal: ctx().signal,
    })
    expect(submitted.success).toBe(true)
    if (submitted.success) {
      expect(snapshotOf(submitted).text).toContain("Secret accepted")
      expect(JSON.stringify(submitted)).not.toContain("hunter2")
    }
  })

  test("P0-2 redacts browser snapshots and bounded evaluate structures in the engine", async () => {
    runtime.kernel.addRedactionValue("hunter2-secret")
    const page = await open("/redaction")
    const snapshotJson = JSON.stringify(page)
    expect(snapshotJson).not.toContain("hunter2-secret")
    expect(page.text).toContain("[REDACTED]")
    const evaluated = await engine.evaluate({
      tabId: page.tabId,
      botId: botA,
      expression:
        "({text: document.body.innerText, value: document.querySelector('#secret-value').value, title: document.title, note: window.secretNote, huge: 'x'.repeat(100000)})",
      signal: ctx().signal,
    })
    expect(evaluated.success).toBe(true)
    expect(JSON.stringify(evaluated)).not.toContain("hunter2-secret")
    if (evaluated.success)
      expect(new TextEncoder().encode(JSON.stringify(evaluated.structured)).length).toBeLessThanOrEqual(20 * 1024)
  })

  test("R10 repeated failures are capped", async () => {
    const snapshot = await open("/basic")
    const target = { kind: "css" as const, selector: ".missing" }
    expect(
      await engine.click({
        tabId: snapshot.tabId,
        botId: botA,
        target,
        button: "left",
        clickCount: 1,
        timeoutMs: 10000,
        signal: ctx().signal,
      }),
    ).toMatchObject({ success: false, errorCode: "TARGET_NOT_FOUND" })
    expect(
      await engine.click({
        tabId: snapshot.tabId,
        botId: botA,
        target,
        button: "left",
        clickCount: 1,
        timeoutMs: 10000,
        signal: ctx().signal,
      }),
    ).toMatchObject({ success: false, errorCode: "TARGET_NOT_FOUND" })
    expect(
      await engine.click({
        tabId: snapshot.tabId,
        botId: botA,
        target,
        button: "left",
        clickCount: 1,
        timeoutMs: 10000,
        signal: ctx().signal,
      }),
    ).toMatchObject({ success: false, errorCode: "REPEATED_FAILURE" })
  })

  test("SITE_BLOCKED names anti-bot challenge pages and leaves ordinary 403 pages alone", async () => {
    const snapshot = await open("/basic")
    const navigate = (path: string) =>
      engine.navigate({
        tabId: snapshot.tabId,
        botId: botA,
        url: `${base}${path}`,
        action: "goto",
        timeoutMs: 10000,
        signal: ctx().signal,
      })
    expect(await navigate("/challenge-header")).toMatchObject({
      success: false,
      errorCode: "SITE_BLOCKED",
      error: expect.stringContaining("browser_request_takeover"),
    })
    expect(await navigate("/forbidden")).toMatchObject({ success: true })
    expect(await engine.open({ url: `${base}/challenge-reference`, ctx: ctx(), timeoutMs: 20000 })).toMatchObject({
      success: false,
      errorCode: "SITE_BLOCKED",
      error: expect.stringContaining("Akamai"),
    })
  })

  test("persistence restores unloaded tabs, popups are owned, dialogs are visible, and ownership is enforced", async () => {
    const cookie = await open("/cookie")
    const cookieValue = await engine.evaluate({
      tabId: cookie.tabId,
      botId: botA,
      expression: "document.cookie",
      signal: ctx().signal,
    })
    expect(cookieValue).toMatchObject({ success: true, structured: "touri_fixture=present" })
    await engine.shutdown()
    engine = createBrowserEngine({ kernel: runtime.kernel })
    const restored = await engine.snapshot({ tabId: cookie.tabId, botId: botA, image: "never", signal: ctx().signal })
    expect(restored.success).toBe(true)
    const restoredCookie = await engine.evaluate({
      tabId: cookie.tabId,
      botId: botA,
      expression: "document.cookie",
      signal: ctx().signal,
    })
    expect(restoredCookie).toMatchObject({ success: true, structured: "touri_fixture=present" })
    const popup = await open("/popup")
    const popupClick = await engine.click({
      tabId: popup.tabId,
      botId: botA,
      target: { kind: "role", role: "button", name: "Open popup", exact: true },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(popupClick.success).toBe(true)
    await Bun.sleep(250)
    const listed = await engine.list({ botId: botA })
    expect(JSON.stringify(listed)).toContain("openerTabId")
    if (listed.success) {
      const popupTab = (listed.structured as { tabs: Array<{ tabId: string; openerTabId: string | null }> }).tabs.find(
        (tab) => tab.openerTabId === popup.tabId,
      )
      expect(popupTab).not.toBeUndefined()
    }
    const dialog = await open("/dialog")
    const dialogClick = await engine.click({
      tabId: dialog.tabId,
      botId: botA,
      target: { kind: "role", role: "button", name: "Confirm", exact: true },
      button: "left",
      clickCount: 1,
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(snapshotOf(dialogClick).notes.some((note) => note.includes("confirm"))).toBe(true)
    const dismissed = await engine.press({
      tabId: dialog.tabId,
      botId: botA,
      key: "Escape",
      timeoutMs: 10000,
      signal: ctx().signal,
    })
    expect(snapshotOf(dismissed).notes.some((note) => note.includes("dialog is open"))).toBe(false)
    expect(
      await engine.snapshot({ tabId: dialog.tabId, botId: botB, image: "never", signal: ctx(botB, threadB).signal }),
    ).toMatchObject({ success: false, errorCode: "TAB_NOT_OWNED" })
  })
})

test("Chrome for Testing downloader verifies a pinned fake response without network", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-wp6-download-"))
  const version = "1.0.0"
  const executable = join(
    root,
    version,
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  )
  const manifest = {
    versions: [
      { version, downloads: { chrome: [{ platform: "mac-arm64", url: "https://fixture.invalid/chrome.zip" }] } },
    ],
  }
  const calls: Array<string> = []
  try {
    const result = await downloadChromeForTesting({
      destination: root,
      deps: {
        version,
        fetchFn: async (url) => {
          calls.push(url)
          return url.includes("known-good")
            ? new Response(JSON.stringify(manifest), { status: 200 })
            : new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        },
        extract: async () => {
          mkdirSync(join(root, version, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS"), {
            recursive: true,
          })
          writeFileSync(executable, "fixture")
          return true
        },
        verify: async () => true,
      },
    })
    expect(result).toEqual({ success: true, path: executable, version })
    expect(calls).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Chrome window flags are derived from environment without hardcoded placement", () => {
  expect(deriveChromeWindowArgs({ env: {} })).toEqual(["--window-size=1280,860"])
  expect(
    deriveChromeWindowArgs({
      env: { TOURI_BROWSER_WINDOW_POSITION: "-1920,-251", TOURI_BROWSER_WINDOW_SIZE: "1920,1080" },
    }),
  ).toEqual(["--window-size=1920,1080", "--window-position=-1920,-251"])
  expect(
    deriveChromeWindowArgs({ env: { TOURI_BROWSER_WINDOW_POSITION: "invalid", TOURI_BROWSER_WINDOW_SIZE: "0,860" } }),
  ).toEqual(["--window-size=1280,860"])
  expect(
    deriveChromeLaunchArgs({ profile: "/tmp/touri-browser-test", env: { TOURI_BROWSER_HEADLESS: "1" } }),
  ).toContain("--headless=new")
  expect(deriveChromeLaunchArgs({ profile: "/tmp/touri-browser-test", env: {} })).not.toContain("--headless=new")
  expect(
    deriveChromeWindowConfig({
      env: {
        TOURI_BROWSER_HEADLESS: "1",
        TOURI_BROWSER_WINDOW_POSITION: "-1920,-251",
        TOURI_BROWSER_WINDOW_SIZE: "1920,1080",
      },
    }),
  ).toEqual({
    width: 1920,
    height: 1080,
    left: -1920,
    top: -251,
    headless: true,
  })
})

test("P2-3 port fallback is ephemeral and loopback-only", () => {
  const args = deriveChromePortLaunchArgs({ profile: "/tmp/touri-browser-test", env: { TOURI_BROWSER_HEADLESS: "1" } })
  expect(args).toContain("--remote-debugging-address=127.0.0.1")
  expect(args).toContain("--remote-debugging-port=0")
  expect(args).not.toContain("--remote-debugging-pipe")
  expect(parseDevToolsActivePort("4321\n/devtools/browser/test\n")).toEqual({
    port: 4321,
    path: "/devtools/browser/test",
  })
  expect(parseDevToolsActivePort("9222\n/devtools/browser/test\n")).toEqual({
    port: 9222,
    path: "/devtools/browser/test",
  })
  expect(parseDevToolsActivePort("0\n/devtools/browser/test\n")).toBeNull()
  expect(parseDevToolsActivePort("4321\n")).toBeNull()
})

test("P2-5 deadline cleanup has a bounded backstop", async () => {
  const started = Date.now()
  await expect(
    withDeadline({
      operation: async () => new Promise<never>(() => undefined),
      timeoutMs: 25,
      signal: new AbortController().signal,
      onTimeout: async () => new Promise<void>(() => undefined),
    }),
  ).rejects.toThrow("Operation deadline exceeded")
  expect(Date.now() - started).toBeLessThan(700)
})
