import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { init as initComputer } from "../../../sidecar/src/computer"
import { allowedOrigins, createKernel } from "../../../sidecar/src/kernel"
import { createOciProvider } from "../../../sidecar/src/platform/oci-provider"
import { init as initStore } from "../../../sidecar/src/store"
import { createDesktopGateway } from "../../../sidecar/src/vm/desktop"
import { machineActionRoutes } from "../../../sidecar/src/vm/machine-actions"
import { createVmRuntime } from "../../../sidecar/src/vm/runtime"

const binary = process.env.TOURI_TERMINAL_DOCKER
const origin = process.env.TOURI_TERMINAL_ORIGIN
const port = Number(process.env.TOURI_TERMINAL_PORT)
if (!binary || !origin || port < 18800 || port > 18899) throw new Error("Disposable terminal fixture settings missing")

const root = await mkdtemp(join(tmpdir(), "touri-terminal-"))
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
runtime.kernel.registerRoutes({ name: "terminal-machine", routes: machineActionRoutes(runtime.kernel, vm.service) })
const endpoint = `http://127.0.0.1:${port}`
const response = await fetch(`${endpoint}/api/v1/bots`, {
  method: "POST",
  headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Lia", machine: "vm", provider: "codex", computerUse: true }),
})
const { bot } = (await response.json()) as { bot: { id: string } }
if (!bot) throw new Error("Fixture bot creation failed")
const release = await vm.service.acquire({ botId: bot.id })

runtime.kernel.registerRoutes({
  name: "terminal-evidence",
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
      path: "/terminal-evidence",
      handler: async ({ body }) => {
        if ((body as { action?: string }).action === "windows") {
          const id = vm.service.states().find((state) => state.botId === bot.id)?.connection?.machineId
          if (!id) return { status: 409, json: {} }
          const result = await provider.exec({
            id,
            user: "1001",
            env: { DISPLAY: ":99", XAUTHORITY: "/var/lib/touri-browser/.Xauthority" },
            command: "xdotool",
            args: ["search", "--onlyvisible", "--class", "XTerm"],
          })

          return { status: 200, json: result }
        }
        const command = (body as { command: string }).command
        if (!["cat /workspace/.home/terminal-proof.txt", "id -u", "pwd"].includes(command))
          return { status: 400, json: {} }
        const result = await vm.service.exec({ botId: bot.id, command: "/bin/sh", args: ["-c", command] })

        return { status: 200, json: result }
      },
    },
  ],
})
console.log(`TERMINAL_FIXTURE:${port}:${bot.id}`)

const stop = async () => {
  await desktop.service.closeBot(bot.id)
  desktop.service.dispose()
  await release()
  await vm.service.destroy({ botId: bot.id })
  await vm.dispose()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())
