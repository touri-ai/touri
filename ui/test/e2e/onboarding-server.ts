import type { RunCommand } from "../../../sidecar/src/cli/tailscale"
import { createKernel } from "../../../sidecar/src/kernel"
import { initModules } from "../../../sidecar/src/main"
import { createDesktopWeb } from "../../../sidecar/src/onboarding/desktop"
import { probeServer } from "../../../sidecar/src/onboarding/discovery"

const directory = process.env.TOURI_APP_DATA
const port = Number(process.env.TOURI_ONBOARDING_TEST_PORT)
if (!directory || port < 18800 || port > 18899) throw new Error("Isolated staging configuration required")
let target: string | null = null
const run: RunCommand = async (_command, args) => {
  if (args[0] === "status")
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "local.example.ts.net." },
        Peer: {
          fast: { DNSName: "studio.example.ts.net.", Online: true },
          slow: { DNSName: "sleeping.example.ts.net.", Online: true },
        },
      }),
    }
  if (args[0] === "serve" && args[1] === "status")
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        Web: target ? { "local.example.ts.net:8445": { Handlers: { "/": { Proxy: target } } } } : {},
      }),
    }
  target = args.at(-1) === "off" ? null : (args.at(-1) ?? null)
  return { code: 0, stderr: "", stdout: "" }
}
const desktop = await createDesktopWeb(directory, {
  port,
  localServerUrl: process.env.TOURI_ONBOARDING_LOCAL_URL ?? null,
  run,
  probe: async (url, signal) => {
    if (url === "https://studio.example.ts.net:8445") return true
    if (url === "https://sleeping.example.ts.net:8445") {
      await Bun.sleep(800)
      return false
    }
    if (url.includes(".ts.net")) return false
    return probeServer(url, signal)
  },
})
const runtime = createKernel({ appData: directory, web: desktop.web })
await desktop.init(runtime.kernel, runtime.handshake.port)
await initModules(runtime)
process.stdout.write("ready\n")
const stop = async () => {
  await runtime.kernel.services.use("runtime.shutdown")?.()
  await runtime.stop()
  await desktop.close()
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())
