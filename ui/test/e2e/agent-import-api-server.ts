import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { Kernel } from "@touri/contracts"
import { closeFileIoAsync } from "../../../sidecar/src/kernel/async-files"
import { bindDeviceSession } from "../../../sidecar/src/kernel/device-session"
import { getMaximum, getPercentile, startEventLoopLagProbe } from "../../../sidecar/test/fakes/latency"

// The optional root lets the same browser fixture demonstrate the API before the change.
const root = resolve(process.env.TOURI_IMPORT_BACKEND_ROOT ?? "..")
const { createKernel } = await import(`${root}/sidecar/src/kernel/index.ts`)
const { init: initStore } = await import(`${root}/sidecar/src/store/index.ts`)
const { init: initRuntime } = await import(`${root}/sidecar/src/runtime/index.ts`)
const { init: initImporter } = await import(`${root}/sidecar/src/importer/index.ts`)
const { createVmRuntime } = await import(`${root}/sidecar/src/vm/runtime.ts`)
const { deleteBotRoutes } = await import(`${root}/sidecar/src/vm/delete-bot.ts`)
const { fakeVmProvider } = await import(`${root}/sidecar/test/vm/fake-provider.ts`)
const data = await mkdtemp(`${tmpdir()}/agent-import-browser-`)
const runtime = createKernel({
  appData: data,
  web: {
    hostname: "127.0.0.1",
    port: Number(process.argv[2]),
    intercept: async ({ request }: { request: Request }) => {
      if (request.headers.get("Authorization") !== "Bearer fixture") return new Response(null, { status: 401 })
      bindDeviceSession(request.signal, {
        deviceId: "fixture",
        active: () => true,
        person: { id: "owner", role: "admin", name: "Pessoa de teste", email: null, avatarSeed: "fixture" },
      })
      return null
    },
  },
})
Object.assign(runtime.kernel, { callHost: (async () => ({ success: true, value: {} })) as Kernel["callHost"] })
await initStore(runtime.kernel)
await initRuntime(runtime.kernel)
const vm = createVmRuntime({ kernel: runtime.kernel, provider: fakeVmProvider().provider, hostHome: data })
runtime.kernel.registerRoutes({
  name: "fixture-deletion",
  routes: deleteBotRoutes(runtime.kernel, vm.service, async () => 0),
})
await initImporter(runtime.kernel)
const probe = startEventLoopLagProbe(5)
const stop = async () => {
  probe.stop()
  const samples = probe.getSamples()
  console.info(
    JSON.stringify({
      measurement: "server-event-loop",
      intervalMs: 5,
      samples: samples.length,
      p99Ms: getPercentile(samples, 0.99),
      maxMs: getMaximum(samples),
    }),
  )
  await runtime.kernel.services.use("runtime.shutdown")?.()
  await runtime.stop()
  await closeFileIoAsync()
  await rm(data, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => {
  void stop()
})
console.info(JSON.stringify({ port: runtime.handshake.port }))
