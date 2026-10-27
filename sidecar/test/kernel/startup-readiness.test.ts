import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderAdapter } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { init as initRuntime } from "../../src/runtime"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("desktop startup withholds readiness and message admission until the runtime is installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-startup-readiness-"))
  const runtime = createKernel({ appData: root, deferReady: true })
  cleanups.add(async () => {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  runtime.kernel.registerRoutes({
    name: "fixture-machine-capability",
    routes: [{ method: "GET", path: "/machines", handler: async () => ({ status: 200, json: { machines: [] } }) }],
  })
  const request = (path: string, body?: unknown, token = process.env.TOURI_UI_TOKEN ?? "dev-ui-token") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: "tauri://localhost", "Content-Type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })

  const early = await request("/machines")
  const earlySend = await request("/bots/fixture/messages", { text: "Synthetic request", sendId: "first-send" })

  expect(early.status).toBe(503)
  expect(early.headers.get("Retry-After")).toBe("1")
  expect(early.headers.get("Cache-Control")).toBe("no-store")
  expect(await early.json()).toEqual({
    code: "TOURI-E1009",
    errorCode: "SERVER_CONNECTION_FAILED",
    domain: "kernel",
    error: "O serviço está indisponível. Tente novamente em instantes.",
    origin: "service",
    retryable: true,
  })
  expect(earlySend.status).toBe(503)
  expect(await Bun.file(join(root, "run", "handshake.json")).exists()).toBe(false)
  expect((await request("/machines", undefined, "invalid-fixture-token")).status).toBe(401)

  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/workspace/provider", version: "1", loggedIn: true }),
    startTurn: async () => ({ success: false, errorCode: "cli_missing", error: "Inert fixture" }),
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  await initRuntime(runtime.kernel, undefined, { providerAdapters: { codex: adapter } })
  await runtime.markReady()
  const created = await request("/bots", {
    name: "Startup fixture",
    provider: "codex",
    machine: "local",
    browserEnabled: false,
    computerUse: false,
    access: "read-only",
  })
  const { bot } = (await created.json()) as { bot: { id: string } }
  const sent = await request(`/bots/${bot.id}/messages`, { text: "Synthetic request", sendId: "first-send" })

  expect(created.status).toBe(201)
  expect((await request("/machines")).status).toBe(200)
  expect(await Bun.file(join(root, "run", "handshake.json")).json()).toMatchObject({
    port: runtime.handshake.port,
    pid: process.pid,
  })
  expect(sent.status).toBe(201)
  expect(await sent.json()).toMatchObject({ run: { botId: bot.id } })
  expect((await request("/machines", undefined, "invalid-fixture-token")).status).toBe(401)
}, 30_000)
