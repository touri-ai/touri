import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import type { RunCommand } from "../../src/cli/tailscale"
import { createKernel, type KernelRuntime } from "../../src/kernel"
import { createDesktopWeb } from "../../src/onboarding/desktop"

const fixtures = new Set<{ runtime: KernelRuntime; close: () => Promise<void>; directory: string }>()
afterEach(async () => {
  for (const fixture of fixtures) {
    await fixture.runtime.stop()
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
  fixtures.clear()
})

const start = async (host?: Kernel["callHost"], prepare?: (kernel: Kernel) => void) => {
  const directory = await mkdtemp(join(tmpdir(), "touri-onboarding-test-"))
  const run: RunCommand = async () => ({ code: 127, stdout: "", stderr: "" })
  const desktop = await createDesktopWeb(directory, { run, localServerUrl: null })
  const runtime = createKernel({ appData: directory, web: { ...desktop.web, ...(host ? { host: () => host } : {}) } })
  const fixture = { runtime, close: desktop.close, directory }
  fixtures.add(fixture)
  prepare?.(runtime.kernel)
  await desktop.init(runtime.kernel, runtime.handshake.port)
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token = process.env.TOURI_UI_TOKEN || "dev-ui-token",
  ) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "X-Touri-Client": "test", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    })
  return { request, runtime, directory }
}

test("native first run completes without installing tools and persists completion", async () => {
  const fixture = await start()

  const initial = await (await fixture.request("/api/v1/onboarding")).json()
  const completed = await fixture.request("/api/v1/onboarding", "POST", { remote: false })
  const saved = await (await fixture.request("/api/v1/onboarding")).json()

  expect(initial).toMatchObject({ completed: false, hasData: false })
  expect(completed.status).toBe(200)
  expect(saved.completed).toBe(true)
  expect(await Bun.file(join(fixture.directory, "onboarding.json")).json()).toMatchObject({
    completed: true,
    remoteUrl: null,
  })
})

test("requires native authentication, rejects arbitrary outbound probes and remote devices", async () => {
  const fixture = await start()
  const pairingResponse = await fixture.request("/api/v1/onboarding/pair-code", "POST", {})
  const pairing = await pairingResponse.json()
  const claim = await fixture.request("/pair", "POST", { code: pairing.code, client: true, name: "Test device" }, "")
  const device = await claim.json()

  expect((await fixture.request("/api/v1/onboarding", "GET", undefined, "bad-token")).status).toBe(401)
  expect((await fixture.request("/api/v1/onboarding/probe", "POST", { url: "http://metadata.internal" })).status).toBe(
    403,
  )
  expect(claim.status).toBe(200)
  expect((await fixture.request("/api/v1/onboarding", "GET", undefined, device.token)).status).toBe(403)
  expect((await fixture.request("/api/v1/onboarding/pair-code", "POST", {}, device.token)).status).toBe(403)
})

test("paired administrators save credentials through the desktop vault and receive vault failures", async () => {
  const calls: Array<string> = []
  const host: Kernel["callHost"] = async (method) => {
    calls.push(method)
    return { success: false, errorCode: "VAULT_CANCELLED", error: "Vault access canceled" }
  }
  const fixture = await start(host)
  const pairing = await (await fixture.request("/api/v1/onboarding/pair-code", "POST", {})).json()
  const device = await (
    await fixture.request("/pair", "POST", { code: pairing.code, client: true, name: "Test device" }, "")
  ).json()

  const saved = await fixture.request(
    "/api/v1/host/secret",
    "POST",
    { account: "synthetic-account", value: "synthetic-value" },
    device.token,
  )

  expect(calls).toEqual(["keychain.set"])
  expect(saved.status).toBeGreaterThanOrEqual(400)
  expect(await Bun.file(join(fixture.directory, "secrets.enc")).exists()).toBe(false)
})

test("recognizes an existing data directory even when it has settings but no bots", async () => {
  const fixture = await start(undefined, (kernel) => {
    const database = kernel.db as Database
    database
      .query("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("existing-preference", "true", 1_700_000_000_000)
  })

  const status = await (await fixture.request("/api/v1/onboarding")).json()

  expect(status).toMatchObject({ completed: true, hasData: true })
})

test("maintenance checkpoints never dismiss the welcome on a fresh installation", async () => {
  const fixture = await start(undefined, (kernel) => {
    const database = kernel.db as Database
    database
      .query("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("storage.maintenance.progress", '{"cursor":0,"total":0}', 1_700_000_000_000)
    database
      .query("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("storage.upgrade.22", '{"cursor":0,"total":0}', 1_700_000_000_000)
  })

  const status = await (await fixture.request("/api/v1/onboarding")).json()

  expect(status).toMatchObject({ completed: false, hasData: false })
})

test("forwarded requests cannot use the privileged desktop credential", async () => {
  const fixture = await start()

  const response = await fetch(`http://127.0.0.1:${fixture.runtime.handshake.port}/api/v1/onboarding`, {
    headers: {
      Authorization: `Bearer ${process.env.TOURI_UI_TOKEN || "dev-ui-token"}`,
      "X-Touri-Client": "test",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "studio.example.ts.net",
    },
    signal: AbortSignal.timeout(5000),
  })

  expect(response.status).toBe(401)
})
