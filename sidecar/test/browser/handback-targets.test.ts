import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BrowserSnapshot,
  type ToolContext,
  type ToolRegistration,
  type ToolResult,
  validateToolArgs,
} from "@touri/contracts"
import { init } from "../../src/browser"
import { connectCdpWebSocket } from "../../src/browser/cdp"
import { createBrowserEngine } from "../../src/browser/engine"
import { parseDevToolsActivePort } from "../../src/browser/launcher"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
const browserExecutable =
  process.env.TOURI_CHROME_BIN ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chromium-browser")

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test.skipIf(!browserExecutable)(
  "fresh refs and role/name targets work on a synthetic SPA after private handback recovery",
  async () => {
    const fixture = await getFixture()
    const opened = getSnapshot(await fixture.callTool("browser_open", { url: `${fixture.base}/dashboard` }))
    await fixture.attachObserver()
    const handoff = await fixture.callTool("browser_request_takeover", { tabId: opened.tabId, reason: "Sign in" })
    await fixture.evaluate(
      "document.querySelector('#username').value='synthetic-account'; document.querySelector('#password').value='synthetic-passphrase'; document.querySelector('form').requestSubmit()",
    )
    await fixture.engine.releaseTakeover(opened.tabId)

    const privatePage = getSnapshot(await fixture.callTool("browser_snapshot", { tabId: opened.tabId, image: "never" }))
    const privateClick = await fixture.callTool("browser_click", {
      tabId: opened.tabId,
      target: { kind: "role", role: "button", name: "Reports", exact: true },
    })

    expect(handoff).toMatchObject({ success: true, structured: { status: "waiting_for_person" } })
    expect(privatePage.text).toBe("")
    expect(privatePage.elements.every((element) => !element.name && !element.value)).toBe(true)
    expect(privateClick).toMatchObject({ success: false, errorCode: "PRIVATE_TAKEOVER_ACTIVE" })

    // A new document may resume automation; the document used for private input stays protected.
    const reloaded = await fixture.callTool("browser_navigate", { tabId: opened.tabId, action: "reload" })
    const first = getSnapshot(await fixture.callTool("browser_snapshot", { tabId: opened.tabId, image: "never" }))

    const reports = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "ref", ref: getRef(first, "Reports") },
    })

    expect(reloaded.success).toBe(true)
    expect(reports).toMatchObject({ success: true, structured: { text: expect.stringContaining("Reports view") } })
    expect(await fixture.evaluate("Number(localStorage.getItem('synthetic-actions'))")).toBe(1)

    const second = getSnapshot(await fixture.callTool("browser_snapshot", { tabId: first.tabId, image: "never" }))

    const overview = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "ref", ref: getRef(second, "Overview") },
    })
    const fallback = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "role", role: "button", name: "Reports", exact: true },
    })

    expect(overview).toMatchObject({ success: true, structured: { text: expect.stringContaining("Overview view") } })
    expect(fallback).toMatchObject({ success: true, structured: { text: expect.stringContaining("Reports view") } })
    expect(await fixture.evaluate("Number(localStorage.getItem('synthetic-actions'))")).toBe(3)

    const beforeChange = getSnapshot(await fixture.callTool("browser_snapshot", { tabId: first.tabId, image: "never" }))
    await fixture.evaluate("document.querySelector('#refresh').textContent='Different action'")

    const changed = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "ref", ref: getRef(beforeChange, "Refresh dashboard") },
    })

    expect(changed).toMatchObject({ success: false, errorCode: "TARGET_CHANGED" })
    expect(await fixture.evaluate("Number(localStorage.getItem('synthetic-actions'))")).toBe(3)

    const beforeReplacement = getSnapshot(
      await fixture.callTool("browser_snapshot", { tabId: first.tabId, image: "never" }),
    )
    await fixture.evaluate(
      "const reports=document.querySelector('#reports'); reports.replaceWith(reports.cloneNode(true), reports.cloneNode(true))",
    )

    const ambiguousRef = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "ref", ref: getRef(beforeReplacement, "Reports") },
    })
    const ambiguousRole = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "role", role: "button", name: "Reports", exact: true },
    })

    expect(ambiguousRef).toMatchObject({ success: false, errorCode: "AMBIGUOUS_TARGET" })
    expect(ambiguousRole).toMatchObject({ success: false, errorCode: "AMBIGUOUS_TARGET" })
    expect(await fixture.evaluate("Number(localStorage.getItem('synthetic-actions'))")).toBe(3)

    await fixture.evaluate("document.querySelectorAll('#reports')[1].remove()")
    const recovered = getSnapshot(await fixture.callTool("browser_snapshot", { tabId: first.tabId, image: "never" }))

    const recoveredClick = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "ref", ref: getRef(recovered, "Reports") },
    })

    expect(recoveredClick.success).toBe(true)
    expect(await fixture.evaluate("Number(localStorage.getItem('synthetic-actions'))")).toBe(4)

    const beforeSubmit = getSnapshot(recoveredClick)

    const sensitive = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "ref", ref: getRef(beforeSubmit, "Run report") },
    })
    const held = await fixture.callTool("browser_click", {
      tabId: first.tabId,
      target: { kind: "role", role: "button", name: "Reports", exact: true },
    })

    expect(sensitive).toMatchObject({ success: true, structured: { status: "waiting_for_person" } })
    expect(held).toMatchObject({ success: false, errorCode: "TAB_HELD_BY_USER" })
    expect(await fixture.evaluate("Number(localStorage.getItem('synthetic-actions'))")).toBe(4)
    expect(fixture.engine.cancelTakeover({ tabId: first.tabId })).toBe(true)
    expect(fixture.engine.tabsForBot("fixture-bot")[0]?.heldByUser).toBe(false)
  },
  120_000,
)

const getSnapshot = (result: ToolResult): BrowserSnapshot => {
  if (!result.success || !result.structured) throw new Error(`Expected a browser snapshot: ${JSON.stringify(result)}`)

  return result.structured as BrowserSnapshot
}

const getRef = (snapshot: BrowserSnapshot, name: string): string => {
  const element = snapshot.elements.find((element) => element.name === name)
  if (!element) throw new Error(`Missing synthetic target: ${name}`)

  return element.ref
}

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-handback-targets-"))
  const runtime = createKernel({ appData: root })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => getDashboardPage() })
  cleanups.add(async () => {
    runtime.stop()
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  })
  const registered = Promise.withResolvers<ToolRegistration[]>()
  const kernel = new Proxy(runtime.kernel, {
    get(target, key) {
      if (key !== "registerTools") return Reflect.get(target, key)

      return (input: { tools: ToolRegistration[] }) => {
        registered.resolve(input.tools)
        return target.registerTools(input)
      }
    },
  })
  const database = kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('fixture-bot','Synthetic dashboard','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at)
      VALUES ('fixture-thread','fixture-bot','Synthetic dashboard',1,1);
  `)
  const profile = join(root, "chrome")
  await mkdir(profile, { recursive: true })
  if (!browserExecutable) throw new Error("Missing test browser")

  // Only this disposable browser bypasses the sandbox; production flags stay unchanged.
  const chrome = Bun.spawn(
    [
      browserExecutable,
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  cleanups.add(async () => {
    chrome.kill()
    await chrome.exited
  })
  const endpoint = await getEndpoint(profile, chrome)
  const client = await connectCdpWebSocket({ url: endpoint, timeoutMs: 30_000 })
  const engine = createBrowserEngine({
    kernel,
    localBrowser: true,
    profile: "local",
    launcher: { start: async () => ({ client }), stop: () => client.close() },
  })
  cleanups.add(() => engine.shutdown())
  const observer = await connectCdpWebSocket({ url: endpoint, timeoutMs: 30_000 })
  cleanups.add(() => observer.close())
  await init(kernel, undefined, { engine, getDecisionApiKey: async () => null })
  const tools = await registered.promise
  const base = `http://127.0.0.1:${server.port}`
  const ctx: ToolContext = {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: null,
    projectId: null,
    cwd: root,
    signal: new AbortController().signal,
  }
  // A separate connection keeps human simulation from changing the engine's attached session.
  let observerSession: string | null = null
  const attachObserver = async () => {
    const targets = await observer.call<{ targetInfos: Array<{ targetId: string; url: string }> }>("Target.getTargets")
    const target = targets.targetInfos.find((target) => target.url.startsWith(`${base}/`))
    if (!target) throw new Error("Missing synthetic dashboard target")

    const attached = await observer.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })
    observerSession = attached.sessionId
  }
  const evaluate = async (expression: string) => {
    if (!observerSession) throw new Error("Missing synthetic dashboard observer")

    const result = await observer.call<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      observerSession,
    )
    if (result.exceptionDetails) throw new Error("Synthetic dashboard evaluation failed")

    return result.result.value
  }
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = tools.find((tool) => tool.name === name)
    if (!tool) throw new Error(`Missing browser tool: ${name}`)
    const validated = validateToolArgs({ name, args: { ...args, timeoutMs: 30_000 } })
    if (!validated.success) return validated

    return tool.handler({ ctx, args: validated.args })
  }

  return { engine, base, callTool, attachObserver, evaluate }
}

const getEndpoint = async (
  profile: string,
  chrome: ReturnType<typeof Bun.spawn>,
  deadline = performance.now() + 30_000,
): Promise<string> => {
  const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")
  const endpoint = parseDevToolsActivePort(text)
  if (endpoint) return `ws://127.0.0.1:${endpoint.port}${endpoint.path}`
  if (chrome.exitCode !== null || performance.now() >= deadline) throw new Error("Test browser did not start")

  await Bun.sleep(50)
  return getEndpoint(profile, chrome, deadline)
}

const getDashboardPage = (): Response =>
  new Response(
    `<!doctype html><html><head><title>Synthetic dashboard</title></head><body>
      <form id="sign-in"><label>Username<input id="username" autocomplete="username"></label>
        <label>Password<input id="password" type="password" autocomplete="current-password"></label>
        <button type="submit">Sign in</button></form>
      <script>
        const renderDashboard = () => {
          const view = location.pathname.endsWith('/reports') ? 'Reports' : 'Overview';
          document.body.innerHTML = '<main><h1>' + view + ' view</h1><nav>' +
            '<button type="button" id="reports">Reports</button><button type="button" id="overview">Overview</button>' +
            '<button type="button" id="refresh">Refresh dashboard</button></nav>' +
            '<form id="report"><button type="submit">Run report</button></form></main>';
        };
        document.addEventListener('submit', (event) => {
          event.preventDefault();
          if (event.target.id !== 'sign-in') {
            localStorage.setItem('synthetic-actions', String(Number(localStorage.getItem('synthetic-actions')) + 1));
            return;
          }
          localStorage.setItem('synthetic-signed-in', 'yes');
          history.replaceState({}, '', '/dashboard');
          renderDashboard();
        });
        document.addEventListener('click', (event) => {
          const button = event.target.closest('button[type="button"]');
          if (!button) return;
          localStorage.setItem('synthetic-actions', String(Number(localStorage.getItem('synthetic-actions')) + 1));
          if (button.id === 'reports') history.pushState({}, '', '/dashboard/reports');
          if (button.id === 'overview') history.pushState({}, '', '/dashboard');
          renderDashboard();
        });
        if (localStorage.getItem('synthetic-signed-in') === 'yes') renderDashboard();
      </script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
