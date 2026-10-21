import type { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserSnapshot, BrowserTabInfo, RouteModule, ToolRegistration } from "@touri/contracts"
import { init } from "../../../sidecar/src/browser"
import { createBrowserEngine } from "../../../sidecar/src/browser/engine"
import { createHeadlessHost } from "../../../sidecar/src/cli/host/headlessHost"
import { createSecretStore } from "../../../sidecar/src/cli/host/secretStore"
import { createKernel } from "../../../sidecar/src/kernel"
import { init as initStore } from "../../../sidecar/src/store"
import { createFixtureBrowserLauncher } from "./browser-fixture-launcher"

const root = await mkdtemp(join(tmpdir(), "touri-browser-flow-"))
const runtime = createKernel({ appData: join(root, "data") })
const secrets = createSecretStore({ dir: join(root, "vault"), env: { TOURI_SECRETS_KEY: "synthetic-encryption-key" } })
const host = createHeadlessHost({ secrets })({ publish: runtime.kernel.publish, log: runtime.kernel.log })
const handlers = new Map<string, ToolRegistration>()
let browserRoutes: RouteModule | undefined
const kernel = {
  ...runtime.kernel,
  callHost: host,
  registerRoutes: (module: RouteModule) => {
    if (module.name === "browser") browserRoutes = module
    return runtime.kernel.registerRoutes(module)
  },
  registerTools: (input: Parameters<typeof runtime.kernel.registerTools>[0]) => {
    input.tools.forEach((tool) => {
      handlers.set(tool.name, tool)
    })
    return runtime.kernel.registerTools(input)
  },
}
await initStore(kernel)
const launcher = createFixtureBrowserLauncher()
const engine = createBrowserEngine({ kernel, launcher })
const fixtureUrl = process.env.TOURI_BROWSER_FLOW_FIXTURE_URL
if (!fixtureUrl) throw new Error("The local travel fixture URL is missing.")

const db = kernel.db as Database
const now = Date.now()
db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES(?,?,'codex',?,?,?)").run(
  "browser-demo",
  "Lia",
  root,
  now,
  now,
)
db.query("INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES(?,?,'main',?,?,?)").run(
  "browser-thread",
  "browser-demo",
  "Busca de viagem fictícia",
  now,
  now,
)

const ctx = {
  botId: "browser-demo",
  threadId: "browser-thread",
  runId: "browser-flow-run",
  projectId: null,
  cwd: root,
  signal: new AbortController().signal,
}
let decisionCount = 0
let takeoverInputCount = 0
await init(kernel, undefined, {
  engine,
  getDecisionApiKey: async () => "synthetic-decision-key",
  fetchDecision: async (_url, request) => {
    decisionCount += 1
    const body = JSON.parse(String(request.body)) as {
      state: { candidates: Array<{ ref: string; name: string }> }
    }
    const preferences = ["Destination primary", "Cabin outbound", "Lisboa, Portugal", "October 24"]
    const chosen = preferences.flatMap((name) =>
      body.state.candidates.filter((candidate) => candidate.name.includes(name)),
    )[0]
    const candidates = body.state.candidates
    const confidence = 0.97

    return Response.json({
      answers: {
        target: {
          type: "choice",
          choice: chosen?.ref ?? "none",
          confidence,
          probabilities: Object.fromEntries([
            ...candidates.map((candidate) => [
              candidate.ref,
              candidate === chosen ? confidence : (1 - confidence - 0.01) / Math.max(1, candidates.length - 1),
            ]),
            ["none", 0.01],
          ]),
        },
      },
    })
  },
})

let tabId = ""
let finalImage = ""
let shouldRefreshPublicPage = false
const failedSteps: string[] = []
const commands: Record<string, { tool: string; args: Record<string, unknown> }> = {
  open: { tool: "browser_open", args: { url: fixtureUrl } },
  read: { tool: "browser_snapshot", args: {} },
  destination: {
    tool: "browser_type",
    args: { target: { kind: "role", role: "textbox", name: "Destination" }, text: "Lisboa" },
  },
  option: {
    tool: "browser_click",
    args: { target: { kind: "role", role: "option", name: "Lisboa" } },
  },
  cabin: {
    tool: "browser_select_option",
    args: { target: { kind: "role", role: "combobox", name: "Cabin" }, values: ["business"] },
  },
  calendar: { tool: "browser_click", args: { target: { kind: "css", selector: "#calendar-open" } } },
  date: {
    tool: "browser_click",
    args: { target: { kind: "role", role: "button", name: "Departure date" } },
  },
  search: { tool: "browser_click", args: { target: { kind: "role", role: "button", name: "Search trips" } } },
  wait: { tool: "browser_wait_for", args: { condition: { text: "Two ways to get there" }, timeoutMs: 5000 } },
  tabs: { tool: "browser_list_tabs", args: {} },
  screenshot: { tool: "browser_screenshot", args: {} },
}

const getSnapshot = async (): Promise<BrowserSnapshot | null> => {
  if (!tabId) return null
  const result = await engine.snapshot({
    tabId,
    botId: ctx.botId,
    image: "always",
    signal: ctx.signal,
    timeoutMs: 8000,
  })

  return result.success ? (result.structured as BrowserSnapshot) : null
}

const getFixturePageValue = async <T>(expression: string): Promise<T | null> => {
  const client = await launcher.connectInspection()
  if (!client) return null

  try {
    const { targetInfos } = await client.call<{ targetInfos: Array<{ targetId: string; url: string }> }>(
      "Target.getTargets",
    )
    const target = targetInfos.find((item) => item.url.startsWith(fixtureUrl))
    if (!target) return null
    const { sessionId } = await client.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })
    const { result } = await client.call<{ result: { value?: T } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
    )
    return result.value ?? null
  } finally {
    await client.close()
  }
}

const getTab = (): (BrowserTabInfo & { ownerBotId: string | null }) | null => {
  const tab = engine.tabsForBot(ctx.botId).find((candidate) => candidate.tabId === tabId)

  return tab ? { ...tab, url: "https://travel.example.test" } : null
}

const dispatchControl = async (
  method: "POST" | "DELETE",
  path: string,
  tabId: string,
  body: unknown,
): Promise<Response> => {
  const route = browserRoutes?.routes.find((route) => route.method === method && route.path === path)
  if (!route) throw new Error("The browser control route is missing.")
  const response = await route.handler({ params: { id: tabId }, query: {}, body, signal: ctx.signal })
  if (!("json" in response)) throw new Error("The browser control response was not JSON.")
  const result = response.json as Record<string, unknown>

  return Response.json(typeof result.url === "string" ? { ...result, url: "https://travel.example.test" } : result, {
    status: response.status,
  })
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.headers.get("Authorization") !== `Bearer ${process.env.TOURI_BROWSER_FLOW_TOKEN}`)
      return new Response("Unauthorized", { status: 401 })
    const body = (await request.json()) as Record<string, unknown>
    const step = typeof body.step === "string" ? body.step : ""
    const requestedTabId = typeof body.tabId === "string" ? body.tabId : undefined
    const takeoverTabId = requestedTabId ?? tabId
    if (step === "metadata") {
      const tab = await getTab()
      return Response.json({ tabs: tab ? [tab] : [] })
    }
    if (step === "stats") return Response.json({ decisionCount, failedSteps, takeoverInputCount })
    if (step === "private-target")
      return Response.json(
        await getFixturePageValue(`(() => {
          const bounds = document.querySelector('[aria-label="Destination primary"]')?.getBoundingClientRect()
          return bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, width: innerWidth, height: innerHeight } : null
        })()`),
      )
    if (step === "private-input-status")
      return Response.json({
        received: await getFixturePageValue<boolean>(
          `document.querySelector('[aria-label="Destination primary"]')?.value === "entrada privada fictícia"`,
        ),
      })
    if (step === "preview") {
      const preview = await engine.preview({ botId: ctx.botId, tabId, signal: ctx.signal })
      return Response.json(preview ? { ...preview, url: "https://travel.example.test" } : { image: "" })
    }
    if (step === "attachment") return Response.json({ image: finalImage })
    if (step === "takeover-release") shouldRefreshPublicPage = true
    if (step === "takeover-session")
      return dispatchControl("POST", "/browser/tabs/:id/takeover/session", takeoverTabId, body)
    if (step === "takeover-frame")
      return dispatchControl("POST", "/browser/tabs/:id/takeover/frame", takeoverTabId, body)
    if (step === "takeover-input") {
      const response = await dispatchControl("POST", "/browser/tabs/:id/takeover/input", takeoverTabId, body)
      if (response.ok) takeoverInputCount += 1
      return response
    }
    if (step === "takeover-release")
      return dispatchControl("DELETE", "/browser/tabs/:id/takeover/session", takeoverTabId, body)
    if (step === "open") {
      if (tabId) await engine.close({ tabId, botId: ctx.botId, signal: ctx.signal })
      decisionCount = 0
      takeoverInputCount = 0
      finalImage = ""
      shouldRefreshPublicPage = false
      failedSteps.length = 0
      const result = await engine.open({ url: fixtureUrl, ctx, timeoutMs: 30_000 })
      if (!result.success) return Response.json({ error: result.error }, { status: 500 })
      tabId = (result.structured as BrowserSnapshot).tabId
      return Response.json({
        part: {
          type: "tool_call",
          callId: "browser-flow-open",
          tool: "mcp__touri__browser_open",
          summary: "browser_open",
          inputJson: JSON.stringify({ url: fixtureUrl }),
          outputJson: JSON.stringify({ structured: { tabId } }),
          ok: true,
        },
      })
    }
    if (step === "read" && shouldRefreshPublicPage) {
      // The scripted bot revisits its known public search page after a manual handback.
      const navigation = await engine.navigate({
        tabId,
        botId: ctx.botId,
        url: fixtureUrl,
        action: "goto",
        signal: ctx.signal,
        timeoutMs: 30_000,
      })
      if (!navigation.success) return Response.json({ error: navigation.error }, { status: 500 })
      shouldRefreshPublicPage = false
    }
    const command = commands[step]
    if (!command) return new Response("Unknown browser step", { status: 400 })

    const startedAt = Date.now()
    const result = await handlers.get(command.tool)?.handler({ ctx, args: { tabId, ...command.args } })
    const resolvedAt = Date.now()
    if (!result) return new Response("Browser tool is unavailable", { status: 500 })
    if (!result.success) failedSteps.push(`${step}:${result.errorCode}`)
    const snapshot = step === "screenshot" ? await getSnapshot() : null
    if (step === "screenshot") finalImage = snapshot?.image?.dataUrl ?? ""
    const content = result.success ? [] : (result.content ?? [])
    const part = {
      type: "tool_call",
      callId: `browser-flow-${step}`,
      tool: `mcp__touri__${command.tool}`,
      summary: command.tool,
      inputJson: JSON.stringify(command.args),
      outputJson: JSON.stringify({
        content,
        ...(step === "open" ? { structured: { tabId } } : {}),
      }),
      ...(step === "screenshot" && finalImage
        ? { outputAttachmentId: "browser-flow-final-screenshot", outputBytes: Math.floor((finalImage.length * 3) / 4) }
        : {}),
      startedAt,
      resolvedAt,
      ok: result.success,
    }

    return Response.json({ part })
  },
})

const stop = async () => {
  server.stop(true)
  await engine.shutdown()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
console.log(`BROWSER_ACTIVITY_FIXTURE:${server.port}`)
