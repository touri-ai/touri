import type { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import type { BrowserSnapshot, RouteModule } from "@touri/contracts"
import { init } from "../../../sidecar/src/browser"
import { createBrowserEngine } from "../../../sidecar/src/browser/engine"
import type { CdpClient } from "../../../sidecar/src/browser/types"
import { createHeadlessHost } from "../../../sidecar/src/cli/host/headlessHost"
import { createSecretStore } from "../../../sidecar/src/cli/host/secretStore"
import { createKernel } from "../../../sidecar/src/kernel"
import { init as initStore } from "../../../sidecar/src/store"
import { createFixtureBrowserLauncher } from "./browser-fixture-launcher"

const root = await mkdtemp(join(tmpdir(), "touri-browser-control-"))
const runtime = createKernel({ appData: join(root, "data") })
const secrets = createSecretStore({ dir: join(root, "vault"), env: { TOURI_SECRETS_KEY: "synthetic-test-encryption" } })
const host = createHeadlessHost({ secrets })({ publish: runtime.kernel.publish, log: runtime.kernel.log })
let routes: RouteModule | undefined
const kernel = Object.assign({}, runtime.kernel, {
  callHost: host,
  registerRoutes: (module: RouteModule) => {
    if (module.name === "browser") routes = module
    return runtime.kernel.registerRoutes(module)
  },
})
await initStore(kernel)
const database = kernel.db as Database
database.exec(`
  INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('browser-demo','Lia','codex','/workspace',1,1);
  INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','browser-demo','Synthetic',1,1);
`)
const launcher = createFixtureBrowserLauncher()
const engine = createBrowserEngine({ kernel, launcher })
await init(kernel, undefined, { engine })
let tabId = ""
let continued = false
let generation = 0
kernel.services.provide("runtime.resumeAfterBrowserTakeover", (resume) => {
  if (resume.runId !== `synthetic-run-${generation}`) return false
  continued = true
  return true
})
let inspection: { client: CdpClient; sessionId: string } | null = null
const lifetime = new AbortController()
const loopDelay = monitorEventLoopDelay({ resolution: 10 })
loopDelay.enable()
const fixturePath = join(import.meta.dirname, "fixtures/browser-control.html")
const handleRequest = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (request.method === "GET" && path.startsWith("/viewer/")) {
    const root = process.env.TOURI_BROWSER_CONTROL_UI_ROOT
    if (!root) return new Response(null, { status: 404 })
    const asset = resolve(root, decodeURIComponent(path.slice("/viewer/".length)))
    if (!asset.startsWith(`${root}${sep}`)) return new Response(null, { status: 403 })
    return new Response(Bun.file(asset))
  }
  if (request.method === "GET" && new URL(request.url).pathname === "/page") return new Response(Bun.file(fixturePath))
  if (request.headers.get("authorization") !== `Bearer ${process.env.TOURI_BROWSER_CONTROL_TOKEN}`)
    return new Response(null, { status: 401 })
  const body = (await request.json()) as Record<string, unknown>
  if (body.step === "open") {
    if (inspection) await inspection.client.close()
    inspection = null
    if (tabId) {
      await engine.releaseTakeover(tabId)
      await engine.close({ tabId, botId: "browser-demo", signal: lifetime.signal })
    }
    generation += 1
    continued = false
    loopDelay.reset()
    const result = await engine.open({
      url: `http://127.0.0.1:${server.port}/page`,
      ctx: {
        botId: "browser-demo",
        threadId: "thread",
        runId: null,
        projectId: null,
        cwd: root,
        signal: lifetime.signal,
      },
      timeoutMs: 20_000,
    })
    if (!result.success) return Response.json({ error: result.error }, { status: 500 })
    tabId = (result.structured as BrowserSnapshot).tabId
    await engine.requestTakeover({
      tabId,
      botId: "browser-demo",
      reason: "Conclua a verificação fictícia para continuar.",
      timeoutMs: 120_000,
      signal: lifetime.signal,
      notify: false,
      threadId: "thread",
      runId: `synthetic-run-${generation}`,
    })
    return Response.json({ tabId })
  }
  if (body.step === "inspect") {
    if (!inspection) {
      const client = await launcher.connectInspection()
      if (!client) return new Response(null, { status: 409 })
      const targets = await client.call<{ targetInfos: Array<{ targetId: string; url: string }> }>("Target.getTargets")
      const target = targets.targetInfos.find((target) => target.url.includes("/page"))
      if (!target) return new Response(null, { status: 409 })
      const { sessionId } = await client.call<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })
      inspection = { client, sessionId }
    }
    const { result } = await inspection.client.call<{ result: { value: unknown } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const bounds = (id) => { const rect = document.querySelector(id).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
        return { width: innerWidth, height: innerHeight, scrollY, name: document.querySelector('#name').value, clicks: document.querySelector('#count').textContent, captcha: document.querySelector('#captcha').checked, selection: getSelection().toString(), next: Boolean(location.search), nameBounds: bounds('#name'), clickBounds: bounds('#click'), captchaBounds: bounds('#captcha'), selectionBounds: bounds('#selection'), nextBounds: bounds('#next') }
      })()`,
        returnByValue: true,
      },
      inspection.sessionId,
    )
    return Response.json({
      ...(result.value as object),
      serverLagP99Ms: loopDelay.percentile(99) / 1e6,
      serverLagMaxMs: loopDelay.max / 1e6,
      continued,
      held: engine.tabsForBot("browser-demo").find((tab) => tab.tabId === tabId)?.heldByUser,
    })
  }
  const route = routes?.routes.find(
    (candidate) =>
      candidate.path === String(body.route).slice(String(body.method).length + 1) && candidate.method === body.method,
  )
  if (!route) return new Response(null, { status: 404 })
  const response = await route.handler({ params: { id: tabId }, query: {}, body: body.input, signal: request.signal })
  if (!("json" in response)) return new Response(null, { status: 500 })
  return Response.json(response.json, { status: response.status })
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TOURI_BROWSER_CONTROL_PORT ?? 0),
  fetch: async (request): Promise<Response> => {
    const origin = process.env.TOURI_BROWSER_CONTROL_UI_ORIGIN ?? ""
    const isViewer = Boolean(origin) && request.headers.get("origin") === origin
    const headers = isViewer
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        }
      : {}
    if (request.method === "OPTIONS") return new Response(null, { status: isViewer ? 204 : 403, headers })
    const response = await handleRequest(request)
    return new Response(response.body, {
      status: response.status,
      headers: Object.assign({}, Object.fromEntries(response.headers), headers),
    })
  },
})
const stop = async () => {
  loopDelay.disable()
  lifetime.abort()
  server.stop(true)
  await inspection?.client.close()
  await engine.shutdown()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
console.log(`BROWSER_CONTROL:${server.port}`)
