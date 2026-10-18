import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { initCloud } from "../../sidecar/src/cloud/module"
import { allowedOrigins, createKernel } from "../../sidecar/src/kernel"
import { init as initStore } from "../../sidecar/src/store"
import { createFakeCloud } from "./fake-cloud"

// Dedicated source-only QA processes. Never loads Apple Container or the installed app.
process.env.TOURI_UI_TOKEN ||= "dev-ui-token"
const uiOrigin = process.env.TOURI_CLOUD_QA_UI_ORIGIN ?? "http://127.0.0.1:1479"
allowedOrigins.add(uiOrigin)
let cleanup = () => {}
let fake: ReturnType<typeof createFakeCloud> | undefined
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.TOURI_CLOUD_QA_PORT ?? 1480),
  async fetch(request) {
    const url = new URL(request.url)
    const headers = {
      "Access-Control-Allow-Origin": uiOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    }
    if (request.method === "OPTIONS") return new Response(null, { headers })
    if (url.pathname === "/health") return new Response("ok")
    if (url.pathname === "/approve") {
      const value = (await request.json()) as { userCode: string }
      fake?.approve(value.userCode)
      return Response.json({}, { headers })
    }
    if (url.pathname !== "/fixture") return new Response(null, { status: 404 })
    cleanup()
    const root = mkdtempSync(join(tmpdir(), "touri-cloud-qa-"))
    fake = createFakeCloud()
    const runtime = createKernel({ appData: root })
    const vault = new Map<string, string>()
    runtime.kernel.callHost = (async (method, input) => {
      const args = input as { account: string; value: string }
      if (method === "keychain.get") return { success: true, value: { value: vault.get(args.account) ?? null } }
      if (method === "keychain.set") {
        vault.set(args.account, args.value)
        return { success: true, value: {} }
      }
      if (method === "keychain.delete") {
        vault.delete(args.account)
        return { success: true, value: {} }
      }
      return { success: false, errorCode: "HOST_UNAVAILABLE", error: "No native host in QA" }
    }) as Kernel["callHost"]
    await initStore(runtime.kernel)
    const baseUrl = `http://127.0.0.1:${runtime.handshake.port}`
    const localRequest = async (method: string, path: string, body?: unknown) =>
      fetch(`${baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: "Bearer dev-ui-token",
          "x-touri-client": "cloud-qa",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then((value) => value.json())
    await localRequest("PATCH", "/settings", { cloud: true, cloudBaseUrl: fake.baseUrl })
    const cloud = initCloud(runtime.kernel)
    runtime.kernel.services.provide("vm.runtime", cloud.runtime)
    await cloud.provider.client.store(fake.issueTokens())
    const created = await localRequest("POST", "/bots", {
      name: "Clara",
      provider: "codex",
      machine: "cloud",
      cloudApiKey: "qa-sandbox-key",
    })
    const machine = await cloud.service.park(created.bot.id)
    const settings = (await localRequest("GET", "/settings")).settings
    if (url.searchParams.get("connected") === "false") {
      vault.clear()
      cloud.provider.client.forget()
    }
    const currentFake = fake
    cleanup = () => {
      cloud.dispose()
      runtime.stop()
      currentFake.stop()
      rmSync(root, { recursive: true, force: true })
    }
    return Response.json(
      {
        endpoint: { baseUrl, wsUrl: `ws://127.0.0.1:${runtime.handshake.port}/api/v1/events`, token: "dev-ui-token" },
        bot: created.bot,
        machine,
        settings,
      },
      { headers },
    )
  },
})
console.log(`Cloud QA ready: ${server.url.origin}`)
process.once("SIGTERM", () => {
  cleanup()
  server.stop(true)
  process.exit(0)
})
process.once("SIGINT", () => {
  cleanup()
  server.stop(true)
  process.exit(0)
})
