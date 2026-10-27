import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, ToolContext } from "@touri/contracts"
import { connectCdpWebSocket } from "../../../sidecar/src/browser/cdp"
import { createRoutedBrowserEngine } from "../../../sidecar/src/browser/vm-router"
import { init as initComputer } from "../../../sidecar/src/computer"
import { allowedOrigins, createKernel } from "../../../sidecar/src/kernel"
import { createOciProvider } from "../../../sidecar/src/platform/oci-provider"
import { init as initStore } from "../../../sidecar/src/store"
import { createDesktopGateway } from "../../../sidecar/src/vm/desktop"
import { machineActionRoutes } from "../../../sidecar/src/vm/machine-actions"
import { createVmRuntime } from "../../../sidecar/src/vm/runtime"

const binary = process.env.TOURI_DOCK_DOCKER
const origin = process.env.TOURI_DOCK_ORIGIN
const port = Number(process.env.TOURI_DOCK_PORT)
if (!binary || !origin || port < 18800 || port > 18899) throw new Error("Disposable dock fixture settings missing")

const root = await mkdtemp(join(tmpdir(), "touri-dock-"))
allowedOrigins.add(origin)
const runtime = createKernel({
  appData: root,
  web: {
    hostname: "127.0.0.1",
    port,
    host: () => async () => {
      throw new Error("This fixture has no host capabilities")
    },
    intercept: async ({ request, url }) => {
      if (request.headers.get("origin") && request.headers.get("origin") !== origin)
        return new Response(null, { status: 403 })
      if (request.method === "OPTIONS")
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Touri-Client",
            "Access-Control-Allow-Methods": "GET, POST, DELETE",
          },
        })
      if (request.headers.get("authorization") === "Bearer dev-ui-token") return null
      if (request.headers.get("upgrade") === "websocket" && url.searchParams.has("ticket")) return null

      return new Response(null, { status: 401 })
    },
  },
})
await initStore(runtime.kernel)
await initComputer(runtime.kernel)
const provider = createOciProvider({ engine: "docker", binary, dataDir: root })
const vm = createVmRuntime({
  kernel: runtime.kernel,
  provider,
  hostHome: root,
  capability: { available: true, provider: "docker", reason: null },
})
runtime.kernel.services.provide("vm.runtime", vm.service)
const desktop = createDesktopGateway(runtime.kernel, vm.service, vm.paste)
runtime.kernel.services.provide("vm.desktop", desktop.service)
runtime.kernel.registerRoutes(desktop.routes)
runtime.kernel.registerRoutes({ name: "dock-machine", routes: machineActionRoutes(runtime.kernel, vm.service) })
const endpoint = `http://127.0.0.1:${port}`
const response = await fetch(`${endpoint}/api/v1/bots`, {
  method: "POST",
  headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Lia", machine: "vm", provider: "codex", computerUse: true }),
  signal: AbortSignal.timeout(10_000),
})
const { bot } = (await response.json()) as { bot: Bot }
if (!bot) throw new Error("Fixture bot creation failed")
const release = await vm.service.acquire({ botId: bot.id })

const browser = createRoutedBrowserEngine(runtime.kernel, "system-chrome")
const machineId = vm.service.states().find((state) => state.botId === bot.id)?.connection?.machineId
if (!machineId) throw new Error("Missing disposable machine")
const trusted = (command: string, args: string[]) =>
  provider.exec({
    id: machineId,
    user: "1001",
    env: { DISPLAY: ":99", XAUTHORITY: "/var/lib/touri-browser/.Xauthority", HOME: "/var/lib/touri-browser" },
    command,
    args,
    signal: AbortSignal.timeout(5_000),
  })
const signal = () => AbortSignal.timeout(20_000)
const context = (): ToolContext => ({
  botId: bot.id,
  threadId: bot.mainThreadId ?? "",
  runId: null,
  projectId: null,
  cwd: root,
  signal: signal(),
})
const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Jardim de teste</title>
<body style="font:24px sans-serif;padding:48px;background:#edf4ef;color:#233d31">
<h1>Jardim de teste</h1><p>Navegador compartilhado com o bot.</p>
<button id="save" style="font:inherit;padding:12px">Salvar sessão de teste</button>
<script>document.getElementById('save').onclick=()=>{localStorage.setItem('dock-proof','preservado');document.getElementById('save').textContent='Sessão salva'}</script></body>`
const fixture = await provider.exec({
  id: machineId,
  user: "1000",
  command: "python3",
  detach: true,
  args: [
    "-c",
    `from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers()
  self.wfile.write(${JSON.stringify(fixtureHtml)}.encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',18880),Handler).serve_forever()`,
  ],
})
if (!fixture.success) throw new Error("Local page did not start")

runtime.kernel.registerRoutes({
  name: "dock-evidence",
  routes: [
    {
      method: "GET",
      path: "/machines",
      handler: async () => ({
        status: 200,
        json: { capability: vm.service.capability, machines: vm.service.states() },
      }),
    },
    {
      method: "POST",
      path: "/dock-evidence",
      handler: async ({ body }) => {
        const action = (body as { action?: string }).action
        const argumentsByAction: Record<string, string[]> = {
          windows: ["search", "--onlyvisible", "--class", "^chromium$"],
          panel: ["search", "--class", "tint2", "getwindowgeometry", "--shell"],
          active: ["getactivewindow"],
          minimize: ["getactivewindow", "windowminimize"],
        }
        const args = action && Object.hasOwn(argumentsByAction, action) ? argumentsByAction[action] : undefined
        if (args) return { status: 200, json: await trusted("xdotool", args) }
        if (action === "browser-state") return getBrowserState()
        if (action === "bot-tools") return getBotTools()
        if (action === "security") return getSecurityEvidence()
        return { status: 400, json: {} }
      },
    },
  ],
})
console.log(`DOCK_FIXTURE:${port}:${bot.id}`)

const stop = async () => {
  await desktop.service.closeBot(bot.id)
  desktop.service.dispose()
  await browser.shutdown()
  await release()
  await vm.service.destroy({ botId: bot.id, deleteVolumes: true })
  await vm.dispose()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())

const getBrowserState = async () => {
  const endpoint = await vm.service.browserEndpoint({ botId: bot.id, runningOnly: true, signal: signal() })
  if (!endpoint) return { status: 409, json: {} }
  const cdp = await connectCdpWebSocket({ url: endpoint, signal: signal() })
  try {
    const { targetInfos } = await cdp.call<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }>("Target.getTargets")
    const target = targetInfos.find((target) => target.type === "page" && target.url.includes("18880"))
    if (!target) return { status: 200, json: { pages: targetInfos.filter((target) => target.type === "page").length } }
    const { sessionId } = await cdp.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })
    const state = await cdp.call<{ result: { value: string } }>(
      "Runtime.evaluate",
      { expression: "localStorage.getItem('dock-proof')", returnByValue: true },
      sessionId,
    )
    return {
      status: 200,
      json: {
        targetId: target.targetId,
        state: state.result.value,
        pages: targetInfos.filter((target) => target.type === "page").length,
      },
    }
  } finally {
    await cdp.close()
  }
}

const getBotTools = async () => {
  const tabs = await browser.list({ botId: bot.id, signal: signal() })
  const screenshot = await vm.service.computer({
    ctx: context(),
    name: "computer_screenshot",
    args: { maxWidth: 720 },
  })
  const click = await vm.service.computer({ ctx: context(), name: "computer_click", args: { x: 650, y: 350 } })
  const opened = await browser.open({ url: "http://127.0.0.1:18880/bot", ctx: context(), timeoutMs: 15_000 })
  const frontmost = await vm.service.computer({ ctx: context(), name: "computer_frontmost", args: {} })
  return {
    status: 200,
    json: { tabs, screenshot: screenshot.success, click: click.success, opened: opened.success, frontmost },
  }
}

const getSecurityEvidence = async () => {
  const result = await vm.service.exec({
    botId: bot.id,
    command: "python3",
    args: [
      "-c",
      `import os,socket,urllib.request,json
checks={}
for name,path in [('authority','/var/lib/touri-browser/.Xauthority'),('profile','/var/lib/touri-browser/profile')]:
 try: os.listdir(path) if name=='profile' else open(path,'rb').read();checks[name]=False
 except PermissionError: checks[name]=True
try: urllib.request.urlopen('http://127.0.0.1:9222/json/version',timeout=1);checks['control']=False
except Exception: checks['control']=True
try:
 client=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);client.sendto(b'chrome','/run/touri-desktop/launcher');checks['launcher']=False
except PermissionError: checks['launcher']=True
print(json.dumps(checks))`,
    ],
  })
  return { status: 200, json: result }
}
