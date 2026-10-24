import type { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserSnapshot, RouteModule } from "@touri/contracts"
import { init } from "../../../sidecar/src/browser"
import { createBrowserEngine } from "../../../sidecar/src/browser/engine"
import { createHeadlessHost } from "../../../sidecar/src/cli/host/headlessHost"
import { createSecretStore } from "../../../sidecar/src/cli/host/secretStore"
import { createKernel } from "../../../sidecar/src/kernel"
import { init as initStore } from "../../../sidecar/src/store"
import { createFixtureBrowserLauncher } from "./browser-fixture-launcher"

const root = await mkdtemp(join(tmpdir(), "touri-browser-restart-"))
const fixtureUrl = process.env.TOURI_BROWSER_FLOW_FIXTURE_URL
if (!fixtureUrl) throw new Error("The public fixture URL is missing")

const startState = async () => {
  const runtime = createKernel({ appData: join(root, "data") })
  const secrets = createSecretStore({
    dir: join(root, "vault"),
    env: { TOURI_SECRETS_KEY: "synthetic-encryption-key" },
  })
  const host = createHeadlessHost({ secrets })({ publish: runtime.kernel.publish, log: runtime.kernel.log })
  const routes: RouteModule[] = []
  const kernel = {
    ...runtime.kernel,
    callHost: host,
    registerRoutes: (module: RouteModule) => {
      routes.push(module)
      return runtime.kernel.registerRoutes(module)
    },
  }
  await initStore(kernel)
  kernel.services.provide(
    "runtime.canReturnBrowserTakeover",
    ({ botId, threadId, personId }) =>
      botId === "browser-demo" && threadId === "browser-thread" && personId === "owner",
  )
  const db = kernel.db as Database
  const now = Date.now()
  db.query("INSERT OR IGNORE INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES(?,?,'codex',?,?,?)").run(
    "browser-demo",
    "Lia",
    root,
    now,
    now,
  )
  db.query("INSERT OR IGNORE INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES(?,?,'main',?,?,?)").run(
    "browser-thread",
    "browser-demo",
    "Página fictícia",
    now,
    now,
  )
  const engine = createBrowserEngine({ kernel, launcher: createFixtureBrowserLauncher() })
  await init(kernel, undefined, { engine })

  return { runtime, engine, routes }
}

let state = await startState()
let tabId = ""
const ctx = {
  botId: "browser-demo",
  threadId: "browser-thread",
  runId: "browser-flow-run",
  projectId: null,
  cwd: root,
  signal: new AbortController().signal,
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TOURI_BROWSER_RESTART_PORT),
  fetch: async (request) => {
    if (request.headers.get("Authorization") !== `Bearer ${process.env.TOURI_BROWSER_FLOW_TOKEN}`)
      return new Response("Unauthorized", { status: 401 })
    const body = (await request.json()) as Record<string, unknown>
    const step = body.step
    if (step === "restart") {
      await state.engine.shutdown()
      await state.runtime.stop()
      state = await startState()
      const tab = state.engine.tabsForBot(ctx.botId).find((candidate) => candidate.tabId === tabId)
      return Response.json({ tabId, state: tab?.state })
    }
    if (step === "request-takeover") {
      const result = await state.engine.requestTakeover({
        tabId,
        botId: ctx.botId,
        reason: "Ajuda na página fictícia",
        timeoutMs: 60_000,
        signal: ctx.signal,
      })
      return Response.json({ success: result.success, tabId })
    }
    if (step === "metadata") return Response.json({ tabs: state.engine.tabsForBot(ctx.botId) })
    if (step === "preview") {
      const preview = await state.engine.preview({ botId: ctx.botId, tabId, signal: ctx.signal })
      return Response.json(preview ?? { image: "" })
    }
    if (step === "open") {
      if (tabId) await state.engine.close({ tabId, botId: ctx.botId, signal: ctx.signal })
      const result = await state.engine.open({ url: fixtureUrl, ctx, timeoutMs: 30_000 })
      if (!result.success) return Response.json({ error: result.error }, { status: 500 })
      tabId = (result.structured as BrowserSnapshot).tabId
      return Response.json({
        part: {
          type: "tool_call",
          callId: "browser-flow-open",
          tool: "mcp__touri__browser_open",
          summary: "browser_open",
          inputJson: JSON.stringify({ url: "https://travel.example.test" }),
          outputJson: JSON.stringify({ structured: { tabId } }),
          ok: true,
        },
      })
    }
    const controls = {
      "takeover-control": ["POST", "/browser/tabs/:id/takeover"],
      "takeover-session": ["POST", "/browser/tabs/:id/takeover/session"],
      "takeover-frame": ["POST", "/browser/tabs/:id/takeover/frame"],
      "takeover-input": ["POST", "/browser/tabs/:id/takeover/input"],
      "takeover-release": ["DELETE", "/browser/tabs/:id/takeover/session"],
    } as const
    const control = controls[step as keyof typeof controls]
    if (!control) return new Response("Unknown step", { status: 400 })
    const route = state.routes
      .flatMap((module) => module.routes)
      .find((route) => route.method === control[0] && route.path === control[1])
    if (!route) return new Response("Missing route", { status: 500 })
    const response = await route.handler({ params: { id: tabId }, query: {}, body, signal: ctx.signal })
    if (!("json" in response)) return new Response("Missing response", { status: 500 })
    return Response.json(response.json, { status: response.status })
  },
})

process.once("SIGTERM", async () => {
  await server.stop(true)
  await state.engine.shutdown()
  await state.runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
})
console.log(`BROWSER_RESTART_FIXTURE:${server.port}`)
