import type { Database } from "bun:sqlite"
import { afterAll, afterEach } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Kernel, RouteRequest, UiEvent } from "@touri/contracts"
import { createAgentImportRoutes } from "../../src/agent-import/routes"
import { createKernel } from "../../src/kernel"
import { closeFileIoAsync } from "../../src/kernel/async-files"
import { bindDeviceSession, type DeviceSession } from "../../src/kernel/device-session"
import { init as initRuntime } from "../../src/runtime"
import { init as initStore } from "../../src/store"
import { deleteBotRoutes } from "../../src/vm/delete-bot"
import { createVmRuntime } from "../../src/vm/runtime"
import { fakeVmProvider } from "../vm/fake-provider"

type Cleanup = () => Promise<void>
const cleanups = new Set<Cleanup>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})
afterAll(() => closeFileIoAsync())

export const makeHarness = async ({ now = Date.now }: { now?: () => number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "agent-import-fixture-"))
  const appData = join(root, "app")
  const home = join(root, "home")
  await mkdir(home)
  const runtime = createKernel({ appData })
  const database = runtime.kernel.db as Database
  const callHost = runtime.kernel.callHost
  Object.assign(runtime.kernel, { callHost: (async () => ({ success: true, value: {} })) as Kernel["callHost"] })
  cleanups.add(async () => {
    await runtime.kernel.services.use("runtime.shutdown")?.()
    await runtime.stop()
    Object.assign(runtime.kernel, { callHost })
    await rm(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  await initRuntime(runtime.kernel)
  const fake = fakeVmProvider()
  const vm = createVmRuntime({
    kernel: runtime.kernel,
    provider: fake.provider,
    hostHome: home,
    capability: { available: true, reason: null, provider: "fake" },
    connectionKeys: { rotate: async () => Buffer.alloc(32), remove: async () => undefined },
  })
  runtime.kernel.services.provide("vm.runtime", vm.service)
  runtime.kernel.registerRoutes({
    name: "fixture-delete",
    routes: deleteBotRoutes(runtime.kernel, vm.service, async () => 0),
  })
  const module = createAgentImportRoutes(runtime.kernel, { home, now })
  runtime.kernel.registerRoutes(module)
  const events: UiEvent[] = []
  runtime.kernel.subscribe(({ event }) => events.push(event))
  const request = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "Content-Type": "application/json",
        "x-touri-client": "import-fixture",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    })
  const write = async (path: string, content: string) => {
    const target = join(home, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)

    return target
  }
  const dispatch = async (method: string, path: string, body: unknown, session?: DeviceSession) => {
    const route = module.routes.find((route) => route.method === method && route.path === path)
    if (!route) throw new Error("Missing route")
    const signal = new AbortController().signal
    if (session) bindDeviceSession(signal, session)
    const input: RouteRequest = { params: {}, query: {}, body, signal }

    return route.handler(input)
  }

  return { root, home, appData, runtime, database, events, request, write, dispatch }
}

export const makePayload = () => ({
  agents: [
    {
      name: "Notas",
      personality: "Organiza notas",
      instructions: "Escreva respostas curtas.",
      skills: [
        {
          name: "resumir",
          content: "---\nname: resumir\ndescription: Use when summarizing notes\n---\nResuma o texto.",
        },
      ],
      memories: ["O projeto usa português."],
      routines: [{ name: "Revisar notas", schedule: "0 9 * * *", prompt: "Revise as notas." }],
      integrations: ["Calendário"],
    },
  ],
})

export const allItems = { instructions: true, skills: true, memories: true, routines: true }

export const makeSession = (id = "owner", role: "admin" | "member" = "admin"): DeviceSession => ({
  deviceId: `device-${id}`,
  active: () => true,
  person: { id, role, name: "Pessoa de teste", email: null, avatarSeed: "fixture" },
})

export const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = performance.now() + 10_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Fixture deadline exceeded")
    await Bun.sleep(10)
  }
}
