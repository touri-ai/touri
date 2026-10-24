import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type Server as NetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostMethods, ToolResult } from "@touri/contracts"
import { createBrowserEngine, withDeadline } from "../../src/browser/engine"
import { createChromeLauncher } from "../../src/browser/launcher"
import { assignLegacyCookies } from "../../src/browser/legacyCookieMigration"
import { botSessionPath } from "../../src/browser/sessionVault"
import type { CdpClient } from "../../src/browser/types"
import { isAllowedBrowserUrl } from "../../src/browser/urlPolicy"
import { createKernel } from "../../src/kernel"
import { createFakeHost } from "../fakes/fakeHost"
import { assertNoTestChrome, forceHeadlessBrowserTests, hasSystemChrome } from "./test-helper"

setDefaultTimeout(40000)

const MARKER = "R13-FILE-MARKER-9f3a"
const NOT_ALLOWED = "Este endereço não é permitido para o navegador do bot: apenas http e https."

type Snapshot = { tabId: string; url: string; text: string }

const snapshotOf = (value: ToolResult): Snapshot => (value as { structured?: unknown }).structured as Snapshot
const everything = (value: unknown): string => JSON.stringify(value)

const html = (body: string): Response =>
  new Response(`<!doctype html><html><head><title>r13</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })

const keychain = new Map<string, string>()
const setKeychain = ({ account, value }: { account: string; value: string }): Record<string, never> => {
  keychain.set(account, value)
  return {}
}
const deleteKeychain = (account: string): Record<string, never> => {
  keychain.delete(account)
  return {}
}

const startHost = async (socketPath: string): Promise<NetServer> => {
  const fake = createFakeHost()
  fake.methods["secret.prompt"] = async () => {
    await secretPromptHook?.()
    return { values: { password: "r13-fresh-secret", username: "r13-fresh-secret", otp: "r13-fresh-secret" } }
  }
  const host = createServer((socket) => {
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
          const result =
            request.method === "auth"
              ? { ok: true }
              : request.method === "keychain.set"
                ? setKeychain(request.params as { account: string; value: string })
                : request.method === "keychain.get"
                  ? { value: keychain.get((request.params as { account: string }).account) ?? null }
                  : request.method === "keychain.delete"
                    ? deleteKeychain((request.params as { account: string }).account)
                    : request.method === "secret.prompt"
                      ? await fake.methods["secret.prompt"](request.params as HostMethods["secret.prompt"]["params"])
                      : {}
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
        })()
      }
    })
  })
  await new Promise<void>((resolve) => host.listen(socketPath, resolve))
  return host
}

const realTest = hasSystemChrome ? test : test.skip

let root = ""
let secretFile = ""
let base = ""
let runtime: ReturnType<typeof createKernel>
let engine: ReturnType<typeof createBrowserEngine>
let server: ReturnType<typeof Bun.serve>
let browserClient: CdpClient | null = null
let host: NetServer | null = null
let originalHostSocket: string | undefined
let insertTextCalls = 0
let secretPromptHook: (() => Promise<void>) | null = null
const pageSessions: Array<string> = []
const botA = "bot-r13-a"
const botB = "bot-r13-b"
const threadA = "thread-r13-a"
const threadB = "thread-r13-b"

const insertOwner = (botId: string, threadId: string): void => {
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
}

const makeEngine = (): ReturnType<typeof createBrowserEngine> => {
  const launcher = createChromeLauncher({ kernel: runtime.kernel })
  return createBrowserEngine({
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
              if (method === "Input.insertText") insertTextCalls += 1
              if (method === "Runtime.evaluate" && sessionId && !pageSessions.includes(sessionId))
                pageSessions.push(sessionId)
              return started.client.call(method, params, sessionId)
            },
          },
        }
      },
    },
  })
}

beforeAll(async () => {
  if (!hasSystemChrome) return
  forceHeadlessBrowserTests()
  root = mkdtempSync(join(tmpdir(), "touri-r13-browser-"))
  mkdirSync(join(root, "run"), { recursive: true })
  secretFile = join(root, "private.txt")
  writeFileSync(secretFile, `${MARKER}\n`)
  originalHostSocket = process.env.TOURI_HOST_SOCK
  host = await startHost(join(root, "run", "host.sock"))
  process.env.TOURI_HOST_SOCK = join(root, "run", "host.sock")
  runtime = createKernel({ appData: root })
  insertOwner(botA, threadA)
  insertOwner(botB, threadB)
  engine = makeEngine()
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      const fileUrl = `file://${secretFile}`
      if (url.pathname === "/basic") return html('<p>Basic ready</p><input aria-label="Name">')
      if (url.pathname === "/redirect-file") return new Response(null, { status: 302, headers: { location: fileUrl } })
      if (url.pathname === "/link-file") return html(`<a id="go" href="${fileUrl}">Open private</a>`)
      if (url.pathname === "/link-data")
        return html(`<a id="go" href="data:text/html,<h1>${MARKER}</h1>">Open data</a>`)
      if (url.pathname === "/open-file") return html(`<button id="go" onclick="window.open('${fileUrl}')">Pop</button>`)
      if (url.pathname === "/cookie-set")
        return html('<p>cookie set</p><script>document.cookie="r13_session=bot-a-secret; path=/"</script>')
      if (url.pathname === "/secret-frames")
        return html(`<iframe title="evil" src="http://localhost:${server.port}/secret"></iframe>`)
      if (url.pathname === "/secret")
        return html('<label>Password <input id="password" type="password" aria-label="Password"></label>')
      return new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  if (!hasSystemChrome) return
  secretPromptHook = null
  insertTextCalls = 0
  for (const tab of engine.tabsForBot(null)) {
    const signal = new AbortController().signal
    const closed = await engine.close({ tabId: tab.tabId, botId: botA, signal })
    if (!closed.success) await engine.close({ tabId: tab.tabId, botId: botB, signal })
  }
})

afterAll(async () => {
  if (!hasSystemChrome) return
  try {
    await engine.shutdown()
    await assertNoTestChrome({ profile: join(root, "browser", "profiles", "default") })
  } finally {
    await runtime.stop()
    server.stop(true)
    await new Promise<void>((resolve) => (host ? host.close(() => resolve()) : resolve()))
    if (originalHostSocket === undefined) delete process.env.TOURI_HOST_SOCK
    else process.env.TOURI_HOST_SOCK = originalHostSocket
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
const open = (url: string, botId = botA, threadId = threadA): Promise<ToolResult> =>
  engine.open({ url, ctx: ctx(botId, threadId), timeoutMs: 20000 })
const openOk = async (path: string, botId = botA, threadId = threadA): Promise<Snapshot> => {
  const result = await open(`${base}${path}`, botId, threadId)
  if (!result.success) throw new Error(everything(result))
  return snapshotOf(result)
}
const click = (tabId: string, selector: string, botId = botA): Promise<ToolResult> =>
  engine.click({
    tabId,
    botId,
    target: { kind: "css", selector },
    button: "left",
    clickCount: 1,
    timeoutMs: 10000,
    signal: new AbortController().signal,
  })
const evaluate = async (tabId: string, expression: string, botId = botA): Promise<unknown> => {
  const result = await engine.evaluate({ tabId, botId, expression, signal: new AbortController().signal })
  return (result as { structured?: unknown }).structured
}
const noTabShowsTheFile = (): void => {
  for (const tab of engine.tabsForBot(null)) {
    expect(tab.url.startsWith("file:")).toBe(false)
    expect(tab.url.startsWith("data:")).toBe(false)
  }
}

test("the URL policy admits only http, https and about:blank", () => {
  expect(isAllowedBrowserUrl("https://example.com/a")).toBe(true)
  expect(isAllowedBrowserUrl("http://127.0.0.1:3000")).toBe(true)
  expect(isAllowedBrowserUrl("about:blank")).toBe(true)
  for (const blocked of [
    "file:///etc/passwd",
    " FILE:///etc/passwd",
    "data:text/html,<h1>x</h1>",
    "javascript:alert(1)",
    "chrome://version",
    "chrome-extension://abc/page.html",
    "view-source:https://example.com",
    "devtools://devtools/bundled/inspector.html",
    "filesystem:https://example.com/temporary/a",
    "blob:https://example.com/uuid",
    "ftp://example.com/a",
    "about:srcdoc",
    "not a url",
  ])
    expect(isAllowedBrowserUrl(blocked)).toBe(false)
})

test("withDeadline never starts an operation whose signal was already aborted while queued", async () => {
  const controller = new AbortController()
  controller.abort()
  let started = false
  await expect(
    withDeadline({
      operation: async () => {
        started = true
      },
      timeoutMs: 1000,
      signal: controller.signal,
      onTimeout: async () => undefined,
    }),
  ).rejects.toThrow()
  expect(started).toBe(false)
})

realTest("browser_open refuses file:, data:, javascript:, chrome:, view-source: with a coded pt-BR error", async () => {
  for (const blocked of [
    `file://${secretFile}`,
    `data:text/html,<h1>${MARKER}</h1>`,
    "javascript:alert(1)",
    "chrome://version",
    "view-source:http://127.0.0.1/",
    "blob:http://127.0.0.1/x",
  ]) {
    const result = await open(blocked)
    expect(result).toMatchObject({ success: false, errorCode: "URL_NOT_ALLOWED", error: NOT_ALLOWED })
    expect(everything(result)).not.toContain(MARKER)
  }
  expect(engine.tabsForBot(null)).toHaveLength(0)
})

realTest("browser_navigate refuses a blocked address and keeps the tab on its page", async () => {
  const first = await openOk("/basic")
  for (const blocked of [`file://${secretFile}`, `data:text/html,<h1>${MARKER}</h1>`, "javascript:alert(1)"]) {
    const result = await engine.navigate({
      tabId: first.tabId,
      botId: botA,
      url: blocked,
      action: "goto",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ success: false, errorCode: "URL_NOT_ALLOWED", error: NOT_ALLOWED })
  }
  expect(await evaluate(first.tabId, "location.href")).toBe(`${base}/basic`)
})

realTest("an http page that redirects to file:// never shows the file", async () => {
  const result = await open(`${base}/redirect-file`)
  expect(everything(result)).not.toContain(MARKER)
  noTabShowsTheFile()
})

realTest("clicking a link to file:// or a top-level data: page never shows the content", async () => {
  for (const path of ["/link-file", "/link-data"]) {
    const page = await openOk(path)
    await click(page.tabId, "#go")
    const after = await engine.snapshot({
      tabId: page.tabId,
      botId: botA,
      image: "never",
      signal: new AbortController().signal,
    })
    expect(snapshotOf(after).text).not.toContain(MARKER)
    expect(snapshotOf(after).url).toBe(`${base}${path}`)
    noTabShowsTheFile()
  }
})

realTest("window.open to file:// never creates a readable tab", async () => {
  const page = await openOk("/open-file")
  const clicked = await click(page.tabId, "#go")
  expect(everything(clicked)).not.toContain(MARKER)
  await Bun.sleep(500)
  noTabShowsTheFile()
  for (const tab of engine.tabsForBot(null)) {
    const snapshot = await engine.snapshot({
      tabId: tab.tabId,
      botId: botA,
      image: "never",
      signal: new AbortController().signal,
    })
    expect(everything(snapshot)).not.toContain(MARKER)
  }
})

realTest("a raw CDP navigation of an owned tab to file:// is reverted before the bot can read it", async () => {
  const page = await openOk("/basic")
  const session = pageSessions.at(-1) ?? ""
  expect(session).not.toBe("")
  await (browserClient as CdpClient).call("Page.navigate", { url: `file://${secretFile}` }, session).catch(() => null)
  await Bun.sleep(1000)
  const snapshot = await engine.snapshot({
    tabId: page.tabId,
    botId: botA,
    image: "never",
    signal: new AbortController().signal,
  })
  expect(everything(snapshot)).not.toContain(MARKER)
  noTabShowsTheFile()
})

realTest("normal http and https navigation still works", async () => {
  const first = await openOk("/basic")
  expect(first.text).toContain("Basic ready")
  const second = await engine.navigate({
    tabId: first.tabId,
    botId: botA,
    url: `${base}/secret`,
    action: "goto",
    timeoutMs: 10000,
    signal: new AbortController().signal,
  })
  expect(second.success).toBe(true)
  expect(snapshotOf(second).url).toBe(`${base}/secret`)
})

realTest("R13-B03 bot B cannot read the cookies bot A earned in its own browser session", async () => {
  const pageA = await openOk("/cookie-set", botA, threadA)
  expect(await evaluate(pageA.tabId, "document.cookie", botA)).toContain("r13_session=bot-a-secret")
  const pageB = await openOk("/basic", botB, threadB)
  expect(await evaluate(pageB.tabId, "document.cookie", botB)).not.toContain("r13_session")
  expect(await evaluate(pageB.tabId, "localStorage.length", botB)).toBe(0)
  expect(
    await engine.snapshot({ tabId: pageA.tabId, botId: botB, image: "never", signal: new AbortController().signal }),
  ).toMatchObject({ success: false, errorCode: "TAB_NOT_OWNED" })
})

const secretField = {
  kind: "password" as const,
  target: { kind: "role" as const, role: "textbox" as const, name: "Password", exact: true },
}

realTest("R13-B06 fresh secret entry is refused in a cross-origin iframe of the prompted page", async () => {
  const page = await openOk("/secret-frames")
  const result = await engine.submitSecret({
    tabId: page.tabId,
    botId: botA,
    threadId: threadA,
    projectId: null,
    fields: [secretField],
    submit: "none",
    signal: new AbortController().signal,
  })
  expect(result).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
  expect(insertTextCalls).toBe(0)
})

realTest(
  "R13-B06 fresh secret entry is refused when the tab navigates to another origin during the prompt",
  async () => {
    const page = await openOk("/secret")
    secretPromptHook = async () => {
      const session = pageSessions.at(-1) ?? ""
      await (browserClient as CdpClient).call(
        "Page.navigate",
        { url: `http://localhost:${server.port}/secret` },
        session,
      )
      await Bun.sleep(800)
    }
    const result = await engine.submitSecret({
      tabId: page.tabId,
      botId: botA,
      threadId: threadA,
      projectId: null,
      fields: [secretField],
      submit: "none",
      signal: new AbortController().signal,
    })
    expect(result.success).toBe(false)
    expect(insertTextCalls).toBe(0)
  },
)

realTest("R13-B07 a cancelled operation queued behind a slow one never types after it leaves the queue", async () => {
  const page = await openOk("/basic")
  const slow = engine.waitFor({
    tabId: page.tabId,
    botId: botA,
    condition: { text: "never-appears-r13" },
    timeoutMs: 2500,
    signal: new AbortController().signal,
  })
  await Bun.sleep(200)
  const controller = new AbortController()
  const queued = engine.type({
    tabId: page.tabId,
    botId: botA,
    target: { kind: "css", selector: "input" },
    text: "should-not-be-typed",
    clear: false,
    submit: true,
    timeoutMs: 10000,
    signal: controller.signal,
  })
  controller.abort()
  await slow
  const outcome = await queued
  expect(outcome.success).toBe(false)
  await Bun.sleep(300)
  expect(insertTextCalls).toBe(0)
  expect(await evaluate(page.tabId, "document.querySelector('input').value")).toBe("")
})

test("legacy cookies go to a bot only when it alone owned a tab on that host", () => {
  const cookie = (domain: string, name: string) => ({ name, value: "v", domain, path: "/" })
  const assigned = assignLegacyCookies({
    cookies: [
      cookie(".x.com", "a"),
      cookie("mail.example.com", "b"),
      cookie(".shared.com", "c"),
      cookie(".nobody.com", "d"),
    ],
    ownedHosts: {
      botA: ["twitter.x.com", "shared.com"],
      botB: ["mail.example.com", "www.shared.com"],
    },
  })
  expect(assigned).toEqual({ botA: [cookie(".x.com", "a")], botB: [cookie("mail.example.com", "b")] })
})

realTest(
  "R13-B03 each bot's logins survive a Chrome restart, privately and without crossing to another bot",
  async () => {
    const pageA = await openOk("/cookie-set", botA, threadA)
    expect(await evaluate(pageA.tabId, "document.cookie", botA)).toContain("r13_session=bot-a-secret")
    await engine.shutdown()
    const file = botSessionPath(runtime.kernel, botA)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, "browser", "sessions")).mode & 0o777).toBe(0o700)
    expect(readFileSync(file, "utf8")).not.toContain("bot-a-secret")
    engine = makeEngine()
    const afterA = await openOk("/basic", botA, threadA)
    expect(await evaluate(afterA.tabId, "document.cookie", botA)).toContain("r13_session=bot-a-secret")
    const afterB = await openOk("/basic", botB, threadB)
    expect(await evaluate(afterB.tabId, "document.cookie", botB)).not.toContain("r13_session")
  },
)
