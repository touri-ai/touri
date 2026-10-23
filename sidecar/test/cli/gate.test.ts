import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate, deviceCookieName } from "../../src/cli/web/gate"
import { isDirectLoopback } from "../../src/cli/web/loopback"
import { directoryAssets, embeddedAssets, type UiAsset, type UiAssets } from "../../src/cli/web/uiAssets"
import { deviceSession } from "../../src/kernel/device-session"

const files: Record<string, UiAsset> = {
  "index.html": { file: new Blob(["<html>app</html>"]), type: "text/html; charset=utf-8", immutable: false },
  "assets/app.js": { file: new Blob(["js"]), type: "text/javascript", immutable: true },
}
const ui: UiAssets = { source: "embedded", get: (path) => files[path] ?? null }

const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const makeGate = async ({ trustedProxy = false }: { trustedProxy?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "touri-gate-"))
  const store = await openAuthStore({ filename: join(dir, "auth.db") })
  cleanups.push(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const secrets = createSecretStore({ dir, env: { TOURI_SECRETS_KEY: "k" } })
  const limiter = createRateLimiter({ maxFailures: 3, windowMs: 60_000 })
  const intercept = createWebGate({ store, secrets, ui, limiter, trustedProxy })
  const call = ({
    path,
    method = "GET",
    headers = {},
    body,
    clientIp = "100.64.0.9",
  }: {
    path: string
    method?: string
    headers?: Record<string, string>
    body?: unknown
    clientIp?: string
  }) => {
    const url = new URL(`https://box.example:8445${path}`)
    const request = new Request(url, {
      method,
      headers: { host: "box.example:8445", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return intercept({ request, url, clientIp })
  }
  const pair = async (): Promise<{ token: string; cookie: string }> => {
    const response = await call({
      path: "/pair",
      method: "POST",
      body: { code: (await store.createPairingCode()).code, client: true },
    })
    const payload = (await response?.json()) as { token: string }
    return { token: payload.token, cookie: `${deviceCookieName}=${payload.token}` }
  }
  return { call, pair, store, intercept, secrets, limiter }
}

test("public liveness omits diagnostics and preserves transport and credential restrictions", async () => {
  const { call, intercept } = await makeGate()
  const url = new URL("http://service.example:18800/healthz")

  const health = await call({ path: "/healthz" })
  const head = await call({ path: "/healthz", method: "HEAD" })
  const insecure = await intercept({ request: new Request(url), url, clientIp: "203.0.113.8" })

  expect(health?.status).toBe(200)
  expect(await health?.json()).toEqual({ ok: true })
  expect(head?.status).toBe(200)
  expect(await head?.text()).toBe("")
  expect(insecure?.status).toBe(426)
  expect((await call({ path: "/healthz", method: "POST" }))?.status).toBe(405)
  expect((await call({ path: "/healthz?token=fixture-token" }))?.status).toBe(401)
  expect((await call({ path: "/api/v1/health" }))?.status).toBe(401)
})

test("unauthenticated root shows the pairing page and the API answers 401", async () => {
  const { call } = await makeGate()
  const page = await call({ path: "/" })
  expect(page?.status).toBe(200)
  expect(await page?.text()).toContain("Código de pareamento")
  expect((await call({ path: "/api/v1/bots" }))?.status).toBe(401)
  expect((await call({ path: "/assets/app.js" }))?.status).toBe(200)
  expect((await call({ path: "/api/v1/events", headers: { upgrade: "websocket" } }))?.status).toBe(401)
})

test("pairing sets an httpOnly SameSite=Strict Secure cookie and the device can then use the API and UI", async () => {
  const { call, store } = await makeGate()
  const response = await call({
    path: "/pair",
    method: "POST",
    headers: { "x-forwarded-proto": "https" },
    body: { code: (await store.createPairingCode()).code, name: "Chrome" },
  })
  expect(response?.status).toBe(200)
  const cookie = response?.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("SameSite=Strict")
  expect(cookie).toContain("Secure")
  const sent = cookie.split(";")[0] ?? ""
  expect(await call({ path: "/api/v1/bots", headers: { cookie: sent } })).toBeNull()
  const ui = await call({ path: "/", headers: { cookie: sent } })
  expect(await ui?.text()).toBe("<html>app</html>")
  const payload = (await response?.json()) as { token?: string } | undefined
  expect(payload?.token).toBeUndefined()
})

test("a bearer token works for the CLI and a revoked device is refused", async () => {
  const { call, pair, store } = await makeGate()
  const { token } = await pair()
  const headers = { authorization: `Bearer ${token}`, "X-Touri-Client": "cli" }
  expect(await call({ path: "/api/v1/bots", headers })).toBeNull()
  const [device] = store.listDevices()
  await store.revokeDevice(device?.id ?? "")
  expect((await call({ path: "/api/v1/bots", headers }))?.status).toBe(401)
})

test("same-origin API requests keep their URL origin when browsers omit Origin", async () => {
  const { pair, intercept } = await makeGate()
  const { token } = await pair()
  const url = new URL("https://192.168.1.20:8795/api/v1/session")
  const request = new Request(url, {
    headers: { authorization: `Bearer ${token}`, "X-Touri-Client": "cli" },
  })

  const response = await intercept({ request, url, clientIp: "192.168.1.20" })

  expect(response?.status).toBe(200)
  expect(deviceSession(request.signal)?.origin).toBe(url.origin)
})

test("trusted proxy requests use forwarded host and protocol when Origin is absent", async () => {
  const { pair, intercept } = await makeGate({ trustedProxy: true })
  const { token } = await pair()
  const url = new URL("http://127.0.0.1:8795/api/v1/session")
  const request = new Request(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "X-Touri-Client": "cli",
      "x-forwarded-host": "team-123.ts.net",
      "x-forwarded-proto": "https",
    },
  })

  const response = await intercept({ request, url, clientIp: "127.0.0.1" })

  expect(response?.status).toBe(200)
  expect(deviceSession(request.signal)?.origin).toBe("https://team-123.ts.net")
})

test("both API prefixes accept a paired native client and reject invalid, revoked and query tokens", async () => {
  const { call, pair, store } = await makeGate()
  const { token } = await pair()
  const headers = { authorization: `Bearer ${token}`, "X-Touri-Client": "island" }
  const endpoints = [
    { path: "/api/events", method: "GET" },
    { path: "/api/notifications/pending", method: "GET" },
    { path: "/api/notifications/1/dismiss", method: "POST" },
    { path: "/api/notifications/dismiss-all", method: "POST" },
    { path: "/api/threads/thread-a/respond", method: "POST" },
    { path: "/api/bots/bot-a/messages", method: "POST" },
    { path: "/api/v1/notifications", method: "GET" },
  ]
  for (const endpoint of endpoints) {
    expect(await call({ ...endpoint, headers })).toBeNull()
    expect((await call(endpoint))?.status).toBe(401)
    expect((await call({ ...endpoint, headers: { ...headers, authorization: "Bearer wrong" } }))?.status).toBe(401)
    expect(
      (await call({ ...endpoint, path: `${endpoint.path}?token=${token}`, headers: { "X-Touri-Client": "island" } }))
        ?.status,
    ).toBe(401)
    expect((await call({ ...endpoint, headers: { authorization: headers.authorization } }))?.status).toBe(403)
    expect((await call({ ...endpoint, headers: { ...headers, origin: "https://evil.example" } }))?.status).toBe(403)
  }
  const [device] = store.listDevices()
  await store.revokeDevice(device?.id ?? "")
  for (const endpoint of endpoints) expect((await call({ ...endpoint, headers }))?.status).toBe(401)
})

test("notification aliases use device cookies with the same write-origin checks as v1", async () => {
  const { call, pair } = await makeGate()
  const { cookie } = await pair()
  expect(await call({ path: "/api/notifications/pending", headers: { cookie } })).toBeNull()
  const endpoint = { path: "/api/notifications/1/dismiss", method: "POST" }
  expect(await call({ ...endpoint, headers: { cookie, origin: "https://box.example:8445" } })).toBeNull()
  expect((await call({ ...endpoint, headers: { cookie, origin: "https://evil.example" } }))?.status).toBe(403)
})

test("a pairing code cannot be replayed and repeated failures are rate limited", async () => {
  const { call, store } = await makeGate()
  const { code } = await store.createPairingCode()
  expect((await call({ path: "/pair", method: "POST", body: { code } }))?.status).toBe(200)
  expect((await call({ path: "/pair", method: "POST", body: { code } }))?.status).toBe(401)
  await call({ path: "/pair", method: "POST", body: { code: "AAAA-AAAA-AAAA" } })
  await call({ path: "/pair", method: "POST", body: { code: "AAAA-AAAA-AAAB" } })
  const limited = await call({ path: "/pair", method: "POST", body: { code: (await store.createPairingCode()).code } })
  expect(limited?.status).toBe(429)
  expect(limited?.headers.get("retry-after")).not.toBeNull()
})

test("invite redemption checks Origin and invited email, returns a cookie without exposing the device token, and is single-use", async () => {
  const { call, store } = await makeGate()
  const invite = await store.createInvite({
    actorPersonId: "owner",
    name: "Ana",
    email: "ana@example.test",
    role: "member",
    channelIds: [],
  })
  if (!invite.success) throw new Error("Invite setup failed")
  const endpoint = { path: "/api/v1/invites/redeem", method: "POST" }
  expect((await call({ ...endpoint, body: { token: invite.token, email: "ana@example.test" } }))?.status).toBe(403)
  const mismatch = await call({
    ...endpoint,
    headers: { origin: "https://box.example:8445" },
    body: { token: invite.token, email: "other@example.test" },
  })
  expect(mismatch?.status).toBe(401)
  expect(await mismatch?.text()).not.toContain(invite.token)
  const redeemed = await call({
    ...endpoint,
    headers: { origin: "https://box.example:8445" },
    body: { token: invite.token, email: "ANA@example.test", deviceName: "Join browser" },
  })
  expect(redeemed?.status).toBe(200)
  expect(redeemed?.headers.get("set-cookie")).toContain("HttpOnly")
  const payload = JSON.stringify(await redeemed?.json())
  expect(payload).not.toContain(invite.token)
  expect(
    (
      await call({
        ...endpoint,
        headers: { origin: "https://box.example:8445" },
        body: { token: invite.token, email: "ana@example.test" },
      })
    )?.status,
  ).toBe(401)
  expect((await call({ path: `/api/v1/invites/redeem?invite=${invite.token}` }))?.status).toBe(401)
})

test("email sign-in sends the same accepted response for known and unknown addresses", async () => {
  const { store, secrets, limiter } = await makeGate()
  const invite = await store.createInvite({
    actorPersonId: "owner",
    name: "Ana",
    email: "ana@example.test",
    role: "member",
    channelIds: [],
  })
  if (!invite.success) throw new Error("Invite setup failed")
  const accepted = await store.claimInvite({
    token: invite.token,
    email: "ana@example.test",
    deviceName: "First browser",
  })
  if (!accepted.success) throw new Error("Invite redemption failed")
  const requested: Array<string> = []
  const gate = createWebGate({
    store,
    secrets,
    ui,
    limiter,
    requestEmailSignIn: async ({ emailAddress }) => void requested.push(emailAddress),
  })
  const call = async (email: string) => {
    const url = new URL("https://box.example:8445/api/v1/auth/email")
    const request = new Request(url, {
      method: "POST",
      headers: { host: url.host, origin: url.origin },
      body: JSON.stringify({ email }),
    })
    return gate({ request, url, clientIp: "100.64.0.20" })
  }

  const known = await call("ana@example.test")
  const unknown = await call("nobody@example.test")

  expect(known?.status).toBe(202)
  expect(unknown?.status).toBe(202)
  expect(await known?.text()).toBe(await unknown?.text())
  expect(requested).toEqual(["ana@example.test", "nobody@example.test"])
})

test("a magic link pairs a new device once and never returns its device token", async () => {
  const { call, store } = await makeGate()
  const invite = await store.createInvite({
    actorPersonId: "owner",
    name: "Bia",
    email: "bia@example.test",
    role: "member",
    channelIds: [],
  })
  if (!invite.success) throw new Error("Invite setup failed")
  const member = await store.claimInvite({ token: invite.token, email: invite.invite.email, deviceName: "Phone" })
  if (!member.success) throw new Error("Invite redemption failed")
  const signIn = await store.createEmailSignIn({ email: member.person.email ?? "" })
  if (!signIn.success) throw new Error("Email sign-in setup failed")
  const endpoint = { path: "/api/v1/auth/email/redeem", method: "POST" }
  const wrongOrigin = await call({ ...endpoint, body: { token: signIn.token } })
  expect(wrongOrigin?.status).toBe(403)
  const redeemed = await call({
    ...endpoint,
    headers: { origin: "https://box.example:8445" },
    body: { token: signIn.token, deviceName: "New laptop" },
  })
  expect(redeemed?.status).toBe(200)
  expect(redeemed?.headers.get("set-cookie")).toContain("HttpOnly")
  const cookie = redeemed?.headers.get("set-cookie") ?? ""
  const deviceCookie = cookie.split(";")[0]?.split("=")[1] ?? ""
  expect(store.verifyDeviceToken(deviceCookie)?.personId).toBe(member.person.id)
  expect(JSON.stringify(await redeemed?.json())).not.toContain(deviceCookie)
  const replayed = await call({
    ...endpoint,
    headers: { origin: "https://box.example:8445" },
    body: { token: signIn.token },
  })
  expect(replayed?.status).toBe(401)
})

test("cookie-authenticated writes from another origin are refused", async () => {
  const { call, pair } = await makeGate()
  const { cookie } = await pair()
  const evil = await call({
    path: "/api/v1/threads",
    method: "POST",
    headers: { cookie, origin: "https://evil.example" },
    body: {},
  })
  expect(evil?.status).toBe(403)
  const same = await call({
    path: "/api/v1/threads",
    method: "POST",
    headers: { cookie, origin: "https://box.example:8445" },
    body: {},
  })
  expect(same).toBeNull()
})

test("a paired browser may delete a bot from the same origin", async () => {
  const { call, pair } = await makeGate()
  const { cookie } = await pair()
  const endpoint = { path: "/api/v1/bots/bot-a", method: "DELETE", headers: { cookie } }

  expect(
    await call({
      ...endpoint,
      headers: { ...endpoint.headers, origin: "https://box.example:8445" },
      body: { name: "Bot A" },
    }),
  ).toBeNull()
  expect(
    (
      await call({
        ...endpoint,
        headers: { ...endpoint.headers, origin: "https://other.example" },
        body: { name: "Bot A" },
      })
    )?.status,
  ).toBe(403)
})

test("devices can be listed and revoked over the API", async () => {
  const { call, pair, store } = await makeGate()
  const first = await pair()
  const second = await pair()
  const list = await call({ path: "/api/v1/devices", headers: { cookie: first.cookie } })
  const payload = (await list?.json()) as { devices: Array<{ id: string }>; current: string }
  expect(payload.devices).toHaveLength(2)
  const other = payload.devices.find((device) => device.id !== payload.current)
  const revoked = await call({
    path: `/api/v1/devices/${other?.id}`,
    method: "DELETE",
    headers: { cookie: first.cookie },
  })
  expect(revoked?.status).toBe(200)
  expect((await call({ path: "/api/v1/bots", headers: { cookie: second.cookie } }))?.status).toBe(401)
  expect(store.listDevices().filter((device) => device.revokedAt === null)).toHaveLength(1)
})

test("static serving falls back to index.html for app routes, never for missing files", async () => {
  const { call, pair } = await makeGate()
  const { cookie } = await pair()
  expect(await (await call({ path: "/some/route", headers: { cookie } }))?.text()).toBe("<html>app</html>")
  expect((await call({ path: "/missing.js", headers: { cookie } }))?.status).toBe(404)
  const asset = await call({ path: "/assets/app.js", headers: { cookie } })
  expect(asset?.headers.get("cache-control")).toContain("immutable")
})

test("chat file reads require authentication and reach API routing rather than static assets", async () => {
  const { call, pair } = await makeGate()
  const path = "/api/v1/bots/bot/files/content?path=%2Fworkspace%2Fnotes.md"
  expect((await call({ path }))?.status).toBe(401)
  const { cookie } = await pair()
  expect(await call({ path, headers: { cookie } })).toBeNull()
})

test("serves the linked app favicon from directory and embedded UI assets", async () => {
  const { store, secrets, limiter, pair } = await makeGate()
  const { cookie } = await pair()
  const publicDir = new URL("../../../ui/public/", import.meta.url)
  const html = readFileSync(new URL("../../../ui/index.html", import.meta.url), "utf8")
  expect(html).toContain('<link rel="icon" type="image/x-icon" href="/favicon.ico" />')
  for (const assets of [
    directoryAssets(publicDir.pathname),
    embeddedAssets({ "favicon.ico": new URL("favicon.ico", publicDir).pathname }),
  ]) {
    const intercept = createWebGate({ store, secrets, limiter, ui: assets })
    const url = new URL("https://app.example/favicon.ico")
    const response = await intercept({ request: new Request(url, { headers: { cookie } }), url, clientIp: null })
    if (!response) throw new Error("Favicon response missing")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/x-icon")
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]))
  }
})

test("R13: --no-pair never admits an unpaired caller; another macOS account shares 127.0.0.1", async () => {
  const { call } = await makeGate()
  const direct = { host: "127.0.0.1:8795" }
  expect((await call({ path: "/api/v1/bots", clientIp: "127.0.0.1", headers: direct }))?.status).toBe(401)
  expect((await call({ path: "/api/v1/bots", clientIp: "::1", headers: { host: "localhost:8795" } }))?.status).toBe(401)
  const proxied = { host: "box.example:8445", "x-forwarded-for": "100.64.0.9" }
  expect((await call({ path: "/api/v1/bots", clientIp: "127.0.0.1", headers: proxied }))?.status).toBe(401)
  expect((await call({ path: "/api/v1/bots", clientIp: "100.64.0.9", headers: direct }))?.status).toBe(401)
})

test("without --no-pair even loopback must pair", async () => {
  const { call } = await makeGate()
  expect(
    (await call({ path: "/api/v1/bots", clientIp: "127.0.0.1", headers: { host: "127.0.0.1:8795" } }))?.status,
  ).toBe(401)
})

test("isDirectLoopback rejects forwarded and tailscale headers", () => {
  const headers = (extra: Record<string, string>) => new Headers({ host: "localhost:8795", ...extra })
  expect(isDirectLoopback({ clientIp: "::1", headers: headers({}) })).toBe(true)
  expect(isDirectLoopback({ clientIp: "::1", headers: headers({ "tailscale-user-login": "a@b" }) })).toBe(false)
  expect(isDirectLoopback({ clientIp: null, headers: headers({}) })).toBe(false)
})

test("A06/C-02: remote plain HTTP refuses pairing and spoofed proxy headers", async () => {
  const { store } = await makeGate()
  const gate = createWebGate({
    store,
    ui,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
    secrets: { set: () => {} } as unknown as import("../../src/cli/host/secretStore").SecretStore,
  })
  for (const extra of [{}, { "x-forwarded-proto": "https", "x-forwarded-host": "box.example" }]) {
    const request = new Request("http://box.example/pair", {
      method: "POST",
      headers: { host: "box.example", ...extra },
      body: JSON.stringify({ code: (await store.createPairingCode()).code }),
    })
    const response = await gate({ request, url: new URL(request.url), clientIp: "100.64.0.9" })
    expect(response?.status).toBe(426)
    expect(await response?.text()).toContain("HTTPS")
  }
})

test("C-06: one pairing source cannot spend another browser's failure budget", async () => {
  const { call, store } = await makeGate()
  for (let i = 0; i < 4; i++)
    await call({ path: "/pair", method: "POST", clientIp: "100.64.0.1", body: { code: "wrong" } })
  const response = await call({
    path: "/pair",
    method: "POST",
    clientIp: "100.64.0.2",
    body: { code: (await store.createPairingCode()).code },
  })
  expect(response?.status).toBe(200)
})

test("C-07: pairing rejects oversized Content-Length without reading the body", async () => {
  const { store } = await makeGate()
  const gate = createWebGate({
    store,
    ui,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
    secrets: {} as import("../../src/cli/host/secretStore").SecretStore,
  })
  const request = new Request("https://box.example/pair", {
    method: "POST",
    headers: { host: "box.example", "content-length": "1000000" },
    body: "{}",
  })
  const response = await gate({ request, url: new URL(request.url), clientIp: "100.64.0.1" })
  expect(response?.status).toBe(413)
  expect(request.bodyUsed).toBe(false)
})

test("C-07: chunked pairing counts UTF-8 bytes and cancels at the limit", async () => {
  const { intercept } = await makeGate()
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(out) {
      out.enqueue(new TextEncoder().encode("á".repeat(40_000)))
    },
    cancel() {
      canceled = true
    },
  })
  const request = new Request("https://box.example/pair", {
    method: "POST",
    headers: { host: "box.example" },
    body: stream,
  })
  const response = await intercept({ request, url: new URL(request.url), clientIp: "100.64.0.1" })
  expect(response?.status).toBe(413)
  expect(canceled).toBe(true)
})

test("C-07: slow pairing reads have a deadline and per-source concurrency cannot block another source", async () => {
  const { store, secrets } = await makeGate()
  const gate = createWebGate({
    store,
    secrets,
    ui,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
    pairReadDeadlineMs: 30,
  })
  let canceled = 0
  const call = (source: string, body: BodyInit) => {
    const request = new Request("https://box.example/pair", { method: "POST", headers: { host: "box.example" }, body })
    return gate({ request, url: new URL(request.url), clientIp: source })
  }
  const slow = () =>
    new ReadableStream<Uint8Array>({
      cancel() {
        canceled++
      },
    })
  const a = call("100.64.0.1", slow())
  const b = call("100.64.0.1", slow())
  expect((await call("100.64.0.1", "{}"))?.status).toBe(429)
  expect((await call("100.64.0.2", JSON.stringify({ code: (await store.createPairingCode()).code })))?.status).toBe(200)
  expect((await a)?.status).toBe(408)
  expect((await b)?.status).toBe(408)
  expect(canceled).toBe(2)
})

test("A06: only an explicitly trusted loopback HTTPS proxy can pair and rotate Secure cookies", async () => {
  const { store, secrets } = await makeGate()
  const gate = createWebGate({
    store,
    secrets,
    ui,
    trustedProxy: true,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
  })
  const call = (path: string, body: unknown, cookie?: string) => {
    const request = new Request(`http://box.example${path}`, {
      method: "POST",
      headers: {
        host: "box.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "box.example",
        origin: "https://box.example",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
    return gate({ request, url: new URL(request.url), clientIp: "127.0.0.1" })
  }
  const paired = await call("/pair", { code: (await store.createPairingCode()).code })
  expect(paired?.status).toBe(200)
  const cookie = paired?.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("Secure")
  const rotated = await call("/api/v1/session/rotate", {}, cookie.split(";")[0])
  expect(rotated?.status).toBe(200)
  expect(rotated?.headers.get("set-cookie")).toContain("Secure")
  const token = cookie.split(";")[0]?.split("=")[1] ?? ""
  expect(store.verifyDeviceToken(token)).toBeNull()
})

test("a trusted-proxy server still pairs a direct loopback client that sends no forwarding headers", async () => {
  const { store, secrets } = await makeGate()
  const gate = createWebGate({
    store,
    secrets,
    ui,
    trustedProxy: true,
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
  })
  const pair = async (origin: string) => {
    const request = new Request("http://127.0.0.1:8795/pair", {
      method: "POST",
      headers: { host: "127.0.0.1:8795", origin },
      body: JSON.stringify({ code: (await store.createPairingCode()).code }),
    })
    return gate({ request, url: new URL(request.url), clientIp: "127.0.0.1" })
  }
  expect((await pair("http://127.0.0.1:8795"))?.status).toBe(200)
  expect((await pair("https://127.0.0.1:8795"))?.status).toBe(403)
  expect((await pair("http://evil.example"))?.status).toBe(403)
})

test("fresh browsers load join and its assets without a referrer while APIs stay private", async () => {
  const { call } = await makeGate()

  const page = await call({ path: "/join" })
  const script = await call({ path: "/assets/app.js" })
  const privateApi = await call({ path: "/api/v1/people" })

  expect(page?.status).toBe(200)
  expect(await script?.text()).toBe("js")
  expect(privateApi?.status).toBe(401)
})
