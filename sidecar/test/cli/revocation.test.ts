import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StoreApi, VmRuntime } from "@touri/contracts"
import type { WebSocketOptions } from "bun"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate } from "../../src/cli/web/gate"
import { noAssets } from "../../src/cli/web/uiAssets"
import { createKernel } from "../../src/kernel"
import { init } from "../../src/notify"

test("A03: CLI revocation closes event sockets and notification SSE", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-revoke-"))
  const filename = join(root, "auth.db")
  const store = await openAuthStore({ filename })
  const cli = await openAuthStore({ filename })
  const claimed = await store.claimPairingCode({
    code: (await store.createPairingCode()).code,
    deviceName: "browser",
  })
  if (!claimed.success) throw new Error("pair failed")
  const gate = createWebGate({
    store,
    secrets: createSecretStore({ dir: root, env: { TOURI_SECRETS_KEY: "test" } }),
    ui: noAssets,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
  })
  const runtime = createKernel({
    appData: root,
    web: {
      hostname: "127.0.0.1",
      port: 0,
      intercept: gate,
      host: () => async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "test" }),
    },
  })
  await init(runtime.kernel)
  let released = 0
  runtime.kernel.services.provide("store.api", { getBot: () => ({ machine: "vm" }) } as unknown as StoreApi)
  runtime.kernel.services.provide("vm.runtime", {
    holdViewer: () => () => {
      released++
    },
  } as unknown as VmRuntime)
  let pending = false
  let aborted = false
  runtime.kernel.registerRoutes({
    name: "test",
    routes: [
      {
        method: "POST",
        path: "/lease",
        handler: ({ signal }) =>
          new Promise((resolve) => {
            pending = true
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve({ status: 409, json: { errorCode: "CANCELED" } })
              },
              { once: true },
            )
          }),
      },
    ],
  })
  const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
  const socket = new NativeSocket(`ws://127.0.0.1:${runtime.handshake.port}/api/v1/events`, {
    headers: { cookie: `touri_device=${claimed.token}` },
  })
  let receivedAfterRevocation = false
  socket.onmessage = (message) => {
    // A cold connection first gets its cursor frame; only later events count.
    if (JSON.parse(String(message.data)).type !== "resync") receivedAfterRevocation = true
  }
  const presence = new NativeSocket(
    `ws://127.0.0.1:${runtime.handshake.port}/api/v1/bots/bot/machine/presence/socket`,
    { headers: { cookie: `touri_device=${claimed.token}` } },
  )
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("socket failed"))
    })
    await new Promise<void>((resolve, reject) => {
      if (presence.readyState === WebSocket.OPEN) resolve()
      else {
        presence.onopen = () => resolve()
        presence.onerror = () => reject(new Error("presence failed"))
      }
    })
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/events`, {
      headers: { cookie: `touri_device=${claimed.token}` },
    })
    const reader = response.body?.getReader()
    await reader?.read()
    const lease = fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/lease`, {
      method: "POST",
      headers: { cookie: `touri_device=${claimed.token}` },
      body: "{}",
    })
    for (let i = 0; i < 100 && !pending; i++) await Bun.sleep(5)
    expect(pending).toBe(true)
    await cli.revokeDevice(claimed.device.id)
    runtime.kernel.publish({ type: "import.progress", importId: "after-revoke", phase: "done", done: 1, total: 1 })
    await Bun.sleep(600)
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(receivedAfterRevocation).toBe(false)
    expect(presence.readyState).toBe(WebSocket.CLOSED)
    expect(released).toBe(1)
    expect((await lease).status).toBe(409)
    expect(aborted).toBe(true)
    const ended = await Promise.race([reader?.read().then((result) => result.done), Bun.sleep(500).then(() => false)])
    expect(ended).toBe(true)
    await reader?.cancel()
  } finally {
    socket.close()
    presence.close()
    runtime.stop()
    await store.close()
    await cli.close()
    rmSync(root, { recursive: true, force: true })
  }
})
