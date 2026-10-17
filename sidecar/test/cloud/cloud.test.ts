import { afterEach, expect, test } from "bun:test"
import { createDecipheriv, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, CloudAuthorization, CloudTokens, Kernel, MachineConnection } from "@touri/contracts"
import { createFakeCloud } from "../../../test/fakes/fake-cloud"
import { CloudError, createCloudClient } from "../../src/cloud/client"
import { initCloud } from "../../src/cloud/module"
import { createCloudRuntime } from "../../src/cloud/runtime"
import { createKernel } from "../../src/kernel"
import { trackProviderProcess } from "../../src/runtime/provider-processes"
import { init as initStore } from "../../src/store"
import { deleteBotRoute } from "../../src/vm/delete-bot"
import { createRemoteProvider } from "../../src/vm/remote"
import { connectionKeyId, sealConnection } from "../../src/vm/sealed-connection"

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})
const fixture = async (enabled = true) => {
  const fake = createFakeCloud()
  cleanup.push(() => fake.stop())
  const root = mkdtempSync(join(tmpdir(), "touri-cloud-"))
  const runtime = createKernel({ appData: root })
  cleanup.push(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const vault = new Map<string, string>()
  const host = runtime.kernel.callHost
  runtime.kernel.callHost = (async (method, input) => {
    const body = input as { account: string; value: string }
    if (method === "keychain.get") return { success: true, value: { value: vault.get(body.account) ?? null } }
    if (method === "keychain.set") {
      vault.set(body.account, body.value)
      return { success: true, value: {} }
    }
    if (method === "keychain.delete") {
      vault.delete(body.account)
      return { success: true, value: {} }
    }
    return host(method, input)
  }) as Kernel["callHost"]
  await initStore(runtime.kernel)
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "cloud-test",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }
  await request("PATCH", "/settings", { cloud: enabled, cloudBaseUrl: fake.baseUrl })
  const cloud = initCloud(runtime.kernel)
  cleanup.push(cloud.dispose)
  const client = cloud.provider.client
  const tokens = fake.issueTokens()
  return { fake, root, runtime, vault, request, cloud, client, tokens }
}
const createMachine = async (client: ReturnType<typeof createCloudClient>, botId = "example") => {
  await client.request("POST", "/v1/bots", {
    id: botId,
    name: "Sandbox",
    provider: "codex",
    mainThreadId: `thread-${botId}`,
    auth: "byok-api",
  })
  await client.request("PUT", `/v1/bots/${botId}/key`, { provider: "codex", apiKey: "test-api-key" })
  const provider = createRemoteProvider({ client })
  cleanup.push(() => provider.disconnect())
  const ref = await provider.create({ name: botId, image: "sandbox-v1" })
  if (!ref.success) throw new Error(ref.error)
  return { provider, ref }
}

test("flag off produces zero cloud requests, default local stays account-free", async () => {
  const { request, fake, client, runtime } = await fixture(false)
  expect((await request("GET", "/cloud/account")).body).toMatchObject({ enabled: false, connected: false })
  await expect(client.capabilities()).rejects.toMatchObject({ code: "TOURI-E9013" })
  expect((await request("POST", "/bots", { name: "Local grátis", provider: "codex" })).status).toBe(201)
  expect(fake.calls).toHaveLength(0)
  expect(runtime.kernel.services.use("store.settings")?.().cloud).toBe(false)
})

test("pairing is code-only in renderer, enforces poll interval, expiry, one use and Keychain", async () => {
  const { request, fake, vault } = await fixture()
  const pairing = await request("POST", "/cloud/pair", {})
  expect(pairing.status).toBe(200)
  expect(pairing.body.deviceCode).toBeUndefined()
  fake.approve(pairing.body.userCode)
  expect((await request("POST", "/cloud/pair/poll", {})).body.connected).toBe(false)
  await Bun.sleep(5050)
  expect((await request("POST", "/cloud/pair/poll", {})).body.connected).toBe(true)
  expect(vault.size).toBe(1)
  const state = JSON.stringify((await request("GET", "/cloud/account")).body)
  const secret = JSON.parse([...vault.values()][0] ?? "{}") as CloudTokens
  expect(state).not.toContain(secret.accessToken)
  expect(state).not.toContain(secret.refreshToken)
  expect((await request("DELETE", "/cloud/account")).status).toBe(200)
  expect(vault.size).toBe(0)
  expect((await request("GET", "/cloud/account")).body.connected).toBe(false)
}, 10_000)

test("server rejects expired/reused pairing and refresh replay revokes its family", async () => {
  const { client, fake } = await fixture()
  const pairing = await client.raw<CloudAuthorization>("POST", "/v1/device/authorizations", {})
  fake.approve(pairing.userCode)
  const tokens = await client.raw<CloudTokens>("POST", "/v1/device/token", { deviceCode: pairing.deviceCode })
  await expect(client.raw("POST", "/v1/device/token", { deviceCode: pairing.deviceCode })).rejects.toMatchObject({
    code: "TOURI-E9011",
  })
  const next = await client.raw<CloudTokens>("POST", "/v1/tokens/refresh", { refreshToken: tokens.refreshToken })
  expect(next.refreshToken).not.toBe(tokens.refreshToken)
  await expect(client.raw("POST", "/v1/tokens/refresh", { refreshToken: tokens.refreshToken })).rejects.toMatchObject({
    code: "TOURI-E9001",
  })
  await client.store(next)
  await expect(client.request("GET", "/v1/account")).rejects.toMatchObject({ code: "TOURI-E9001" })
  const expired = await client.raw<CloudAuthorization>("POST", "/v1/device/authorizations", {})
  fake.advance(600_001)
  await expect(client.raw("POST", "/v1/device/token", { deviceCode: expired.deviceCode })).rejects.toMatchObject({
    code: "TOURI-E9011",
  })
})

test("Keychain failure blocks pairing without plaintext fallback", async () => {
  const { runtime, client, tokens, vault } = await fixture()
  runtime.kernel.callHost = (async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "Unavailable",
  })) as Kernel["callHost"]
  await expect(client.store(tokens)).rejects.toMatchObject({ code: "TOURI-E9012" })
  expect(vault.size).toBe(0)
  await expect(client.load()).rejects.toMatchObject({ code: "TOURI-E9012" })
})

test("provider rejects private hosts, incompatible versions, production, stale generation and expired descriptors", async () => {
  const { client, tokens, fake } = await fixture()
  await client.store(tokens)
  const { provider, ref } = await createMachine(client)
  fake.setDescriptor({ origin: "https://other.example" })
  expect(await provider.connection({ id: ref.id })).toMatchObject({ success: false, errorCode: "TOURI-E9008" })
  fake.setDescriptor({ generation: 999 })
  expect(await provider.connection({ id: ref.id })).toMatchObject({ success: false, errorCode: "TOURI-E9007" })
  fake.setDescriptor({ expired: true })
  expect(await provider.connection({ id: ref.id })).toMatchObject({ success: false, errorCode: "TOURI-E9007" })
  fake.setDescriptor({})
  fake.setSandbox(false)
  await expect(client.capabilities()).rejects.toMatchObject({ code: "TOURI-E9014" })
  fake.setSandbox(true)
  fake.setProtocolVersion("2")
  await expect(client.capabilities()).rejects.toMatchObject({ code: "TOURI-E9007" })
  expect(() => client.endpoint("https://other.example/v1/account")).toThrow(CloudError)
  expect(() => client.endpoint(`${fake.baseUrl}/v1/preview?token=secret`)).toThrow(CloudError)
})

test("complete provider lifecycle preserves durable volume and distinguishes park from delete", async () => {
  const { client, tokens, fake, root } = await fixture()
  await client.store(tokens)
  const { provider, ref } = await createMachine(client)
  const inspected = await provider.inspect({ id: ref.id })
  expect(inspected).toMatchObject({ success: true, image: "sandbox-v1" })
  const original = await provider.machine(ref.id)
  for (let i = 0; i < 3; i++) {
    expect((await provider.stop({ id: ref.id })).success).toBe(true)
    expect((await provider.machine(ref.id)).state).toBe("hibernated")
    expect((await provider.start({ id: ref.id })).success).toBe(true)
  }
  const current = await provider.machine(ref.id)
  expect(current.volumeId).toBe(original.volumeId)
  expect(current.generation).toBeGreaterThan(original.generation)
  expect(await provider.exec({ id: ref.id, command: "uname", args: ["-s"] })).toMatchObject({
    success: true,
    stdout: "sandbox-linux\n",
  })
  expect(await provider.exec({ id: ref.id, command: "env", env: { MONGODB_URI: "sentinel" } })).toMatchObject({
    success: false,
    errorCode: "TOURI-E9014",
  })
  const path = join(root, "snapshot.bin")
  expect((await provider.snapshot({ id: ref.id, path })).success).toBe(true)
  expect(readFileSync(path, "utf8")).toContain("persistent-workspace")
  expect(await provider.migrateWorkspace({ id: ref.id, path: root })).toMatchObject({
    success: false,
    errorCode: "TOURI-E9009",
  })
  const volume = await provider.createVolume({ name: "opaque" })
  if (!volume.success) throw new Error(volume.error)
  expect((await provider.deleteVolume({ name: volume.name })).success).toBe(true)
  expect((await provider.destroy({ id: ref.id })).success).toBe(true)
  expect((await provider.machine(ref.id)).state).toBe("deleted")
  expect(fake.transitions.map((value) => value.state)).toContain("parking")
})

test("tenant ownership, idempotency mismatch, old generation and device revocation fail closed", async () => {
  const { client, tokens, fake, runtime } = await fixture()
  await client.store(tokens)
  const { ref, provider } = await createMachine(client)
  const original = await provider.machine(ref.id)
  await client.request("POST", `/v1/machines/${ref.id}/intent`, { intent: "background" }, undefined, "same-key")
  await expect(
    client.request("POST", `/v1/machines/${ref.id}/intent`, { intent: "computer-open" }, undefined, "same-key"),
  ).rejects.toMatchObject({ code: "TOURI-E9005" })
  await provider.stop({ id: ref.id })
  await provider.start({ id: ref.id })
  await expect(
    client.request("POST", `/v1/machines/${ref.id}/exec`, { generation: original.generation, command: "pwd" }),
  ).rejects.toMatchObject({ code: "TOURI-E9005" })
  const other = createCloudClient(runtime.kernel)
  await other.store(fake.issueTokens("account-b"))
  await expect(other.request("GET", `/v1/machines/${ref.id}`)).rejects.toMatchObject({ code: "TOURI-E9003" })
  fake.revoke(tokens.deviceId)
  await expect(client.request("GET", "/v1/account")).rejects.toMatchObject({ code: "TOURI-E9001" })
})

test("remote process streams stdin/stdout/stderr and cancel never uses a local PID", async () => {
  const { client, tokens, runtime } = await fixture()
  await client.store(tokens)
  const { provider, ref } = await createMachine(client)
  const child = provider.spawn({ id: ref.id, command: "cat" })
  if (!child.success) throw new Error(child.error)
  expect(child.target).toBe("remote")
  expect(child.pid).toBe(0)
  await trackProviderProcess(runtime.kernel, child)
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode("hello cloud"))
  await writer.close()
  expect(await new Response(child.stdout).text()).toBe("hello cloud")
  expect(await new Response(child.stderr).text()).toBe("remote stderr")
  expect(await child.exited).toEqual({ code: 0, signal: null })
  const canceled = provider.spawn({ id: ref.id, command: "sleep", args: ["100"] })
  if (!canceled.success) throw new Error(canceled.error)
  canceled.kill("SIGTERM")
  expect((await canceled.exited).signal).toBe("SIGTERM")
})

test("CDP/Preview are authenticated loopback proxies; unauthorized ports are refused", async () => {
  const { client, tokens } = await fixture()
  await client.store(tokens)
  const { provider, ref } = await createMachine(client)
  expect(await provider.forwardPort({ id: ref.id, guestPort: 22 })).toMatchObject({
    success: false,
    errorCode: "TOURI-E9002",
  })
  const cdp = await provider.forwardPort({ id: ref.id, guestPort: 9222 })
  if (!cdp.success) throw new Error(cdp.error)
  const info = await fetch(`${cdp.url}/json/version`).then((res) => res.json())
  expect(info.webSocketDebuggerUrl).toStartWith(`ws://127.0.0.1:${cdp.hostPort}`)
  const ws = new WebSocket(info.webSocketDebuggerUrl)
  const response = new Promise<string>((resolve) => {
    ws.addEventListener("open", () =>
      setTimeout(() => ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })), 30),
    )
    ws.addEventListener("message", ({ data }) => resolve(String(data)))
  })
  expect(JSON.parse(await response).result.product).toBe("Fake Chromium")
  ws.close()
  const preview = await provider.forwardPort({ id: ref.id, guestPort: 3000 })
  if (!preview.success) throw new Error(preview.error)
  expect(await fetch(`${preview.url}/`).then((res) => res.text())).toBe("sandbox preview")
  const original = await provider.machine(ref.id)
  await provider.wait(await client.request("POST", `/v1/machines/${ref.id}/wake`, { generation: original.generation }))
  expect((await fetch(`${cdp.url}/json/version`)).status).toBe(409)
})

test("cloud bot runs remotely with BYOK, send retry is durable and disconnect does not stop it", async () => {
  const { client, tokens, request, runtime, cloud, fake } = await fixture()
  await client.store(tokens)
  expect(
    (await request("POST", "/bots", { name: "Cloud", provider: "codex", machine: "cloud", vmProviderLogin: true }))
      .status,
  ).toBe(400)
  const created = await request("POST", "/bots", {
    name: "Cloud",
    provider: "codex",
    machine: "cloud",
    cloudApiKey: "sentinel-api-key",
  })
  expect(created.status).toBe(201)
  const bot = created.body.bot as Bot
  expect(bot.machine).toBe("cloud")
  const input = {
    threadId: bot.mainThreadId ?? "",
    parentId: null,
    text: "Oi",
    attachmentIds: [],
    clientNonce: "durable-send",
  }
  const first = await request("POST", `/threads/${bot.mainThreadId}/messages`, input)
  const repeated = await request("POST", `/threads/${bot.mainThreadId}/messages`, input)
  expect(first.status).toBe(200)
  expect(repeated.body.message.id).toBe(first.body.message.id)
  cloud.dispose()
  await Bun.sleep(80)
  expect(fake.runs.get(first.body.run.id)?.status).toBe("succeeded")
  expect((await request("GET", `/threads/${bot.mainThreadId}/messages`)).body.messages).toHaveLength(2)
  const serialized = JSON.stringify((await request("GET", "/bots")).body)
  expect(serialized).not.toContain("sentinel-api-key")
  expect(runtime.kernel.redact("sentinel-api-key")).not.toContain("sentinel-api-key")
  expect(fake.calls.filter((call) => call.path.endsWith("/park"))).toHaveLength(0)
})

test("sealed v2 binds generation/expiration in AES-GCM AAD while local v1 remains unchanged", async () => {
  const key = randomBytes(32)
  const connection: MachineConnection = {
    machineId: "machine",
    provider: "remote",
    endpoints: { browser: "https://example.test/v1/cdp", bridge: "wss://example.test/v1/runtime" },
    ports: [],
    display: { name: ":99", width: 1440, height: 900 },
    bridge: { guestPort: 9876, socketPath: "/tmp/touri.sock", connectionFile: "/workspace/connection.sealed.json" },
    authKeyId: connectionKeyId(key),
  }
  const sealed = JSON.parse(
    sealConnection({
      connection,
      key,
      token: "workload-only",
      fence: { generation: 7, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }),
  )
  const { nonce, ciphertext, tag, ...header } = sealed
  expect(header.version).toBe(2)
  expect(header.generation).toBe(7)
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"))
  decipher.setAAD(Buffer.from(JSON.stringify({ ...header, generation: 8 })))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  expect(() => Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()])).toThrow()
  expect(JSON.parse(sealConnection({ connection, key, token: "local" })).version).toBe(1)
})

test("desktop/VNC authenticates through the gateway; control revoke closes the viewer", async () => {
  const { client, tokens, request, runtime, cloud } = await fixture()
  await client.store(tokens)
  runtime.kernel.services.provide("vm.runtime", cloud.runtime)
  const { createDesktopGateway } = await import("../../src/vm/desktop")
  const desktop = createDesktopGateway(runtime.kernel, cloud.runtime)
  cleanup.push(() => desktop.service.dispose())
  runtime.kernel.services.provide("vm.desktop", desktop.service)
  runtime.kernel.registerRoutes(desktop.routes)
  const created = await request("POST", "/bots", {
    name: "Desktop",
    provider: "codex",
    machine: "cloud",
    computerUse: true,
    cloudApiKey: "desktop-api-key",
  })
  expect(created.status).toBe(201)
  const session = await request("POST", `/bots/${created.body.bot.id}/desktop`, { control: true })
  expect(session.status).toBe(200)
  expect(session.body.password).toBeUndefined()
  const frames: Buffer[] = []
  let closed = false
  expect(desktop.service.claim(session.body.sessionId)).toBe(true)
  expect(desktop.service.claim(session.body.sessionId)).toBe(false)
  desktop.service.open(session.body.sessionId, {
    send: (bytes) => {
      frames.push(Buffer.from(bytes))
      return bytes.length
    },
    close: () => {
      closed = true
    },
  })
  const deadline = Date.now() + 2000
  while (!frames.length && Date.now() < deadline) await Bun.sleep(10)
  expect(frames[0]?.toString()).toBe("RFB 003.008\n")
  desktop.service.revokeControl()
  expect(closed).toBe(true)
  expect(frames.map((frame) => frame.toString()).join("")).not.toContain("testVNC!")
})

test("PTY is authenticated binary WS and device revoke terminates it immediately", async () => {
  const { client, tokens, fake } = await fixture()
  await client.store(tokens)
  const { provider, ref } = await createMachine(client)
  const descriptor = await provider.envelope(ref.id)
  const socket = await client.socket(descriptor.channels.pty)
  socket.binaryType = "arraybuffer"
  const reply = new Promise<ArrayBuffer>((resolve) =>
    socket.addEventListener("message", ({ data }) => resolve(data), { once: true }),
  )
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }))
  socket.send(new TextEncoder().encode("pty bytes"))
  expect(new TextDecoder().decode(await reply)).toBe("pty bytes")
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
  fake.revoke(tokens.deviceId)
  await closed
  expect(socket.readyState).toBe(3)
})

test("C-04 cloud runtime forwards keep the authenticated capability URL, never a bare loopback port", async () => {
  const { client, tokens, runtime } = await fixture()
  await client.store(tokens)
  const { provider, ref } = await createMachine(client)
  const cloud = createCloudRuntime(runtime.kernel, provider, {
    machine: async () => {
      throw new Error("unused")
    },
    id: async () => ref.id,
    wake: async () => {
      throw new Error("unused")
    },
    park: async () => {
      throw new Error("unused")
    },
  })
  const preview = await cloud.service.forwardPort({ botId: "bot", guestPort: 3000 })
  expect(preview.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${preview.hostPort}/touri/[0-9a-f]{64}$`))
  expect((await fetch(`http://127.0.0.1:${preview.hostPort}/`)).status).toBe(403)
  expect(await fetch(`${preview.url}/`).then((res) => res.text())).toBe("sandbox preview")
  const endpoint = await cloud.service.browserEndpoint({ botId: "bot" })
  expect(endpoint).toMatch(/\/touri\/[0-9a-f]{64}$/)
})

test("pairing links use the configured web origin and only the short code", async () => {
  const { request, fake, client } = await fixture()
  await request("PATCH", "/settings", { cloudWebOrigin: "http://127.0.0.1:3300" })
  const paired = await request("POST", "/cloud/pair", {})
  expect(paired.status).toBe(200)
  const url = new URL(paired.body.verificationUri)
  expect(url.origin).toBe("http://127.0.0.1:3300")
  expect(url.pathname).toBe("/parear")
  expect(url.searchParams.get("code")).toBe(paired.body.userCode)
  expect(paired.body.deviceCode).toBeUndefined()
  expect(fake.calls.some((call) => call.path.includes("authorizations"))).toBe(true)
  expect(client.webEndpoint("/conta")).toBe("http://127.0.0.1:3300/conta")
  await request("PATCH", "/settings", { cloudWebOrigin: "https://touri.ai" })
  expect(() => client.webEndpoint("/parear", "CODE")).toThrow()
})
test("cloud bot deletion uses machine deletion once and never calls the unsupported volume API", async () => {
  const { request, fake, client, tokens, runtime, cloud } = await fixture()
  runtime.kernel.registerRoutes({ name: "cloud-delete-test", routes: [deleteBotRoute(runtime.kernel, cloud.runtime)] })
  await client.store(tokens)
  const created = await request("POST", "/bots", {
    name: "Cloud delete",
    provider: "codex",
    machine: "cloud",
    cloudApiKey: "sk-test-no-provider",
  })
  expect(created.status).toBe(201)
  const botId = created.body.bot.id
  expect((await request("DELETE", `/bots/${botId}`, { name: "Cloud delete", deleteVolumes: true })).status).toBe(200)
  expect(fake.calls.filter((call) => call.method === "DELETE" && /^\/v1\/machines\//.test(call.path))).toHaveLength(1)
  expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/v1/volumes/"))).toBe(false)
})

test("web-side device revocation clears invalid host credentials so a new pairing can start", async () => {
  const { client, tokens, vault, request } = await fixture()
  await client.store(tokens)
  await client.request("DELETE", `/v1/devices/${tokens.deviceId}`)
  await expect(client.request("GET", "/v1/account")).rejects.toMatchObject({ code: "TOURI-E9001" })
  expect(vault.size).toBe(0)
  expect((await request("GET", "/cloud/account")).body.connected).toBe(false)
  expect((await request("POST", "/cloud/pair", {})).status).toBe(200)
})
