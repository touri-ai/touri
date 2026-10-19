import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { compressBufferedResponse } from "../../src/cli/web/compression"
import { createWebGate } from "../../src/cli/web/gate"
import { directoryAssets, embeddedAssets } from "../../src/cli/web/uiAssets"
import { createKernel } from "../../src/kernel"

const script = 'console.log("synthetic asset");\n'.repeat(200)
const payload = { messages: Array.from({ length: 200 }, (_, id) => ({ id, text: "synthetic message" })) }
const cleanups: Array<() => void> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const fixture = async ({ desktop = false, directory = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-compression-"))
  const files: Record<string, string> = {}
  for (const [name, body] of Object.entries({ "app.js": script, "small.css": "body {}", "image.png": script })) {
    const path = join(root, name)
    writeFileSync(path, body)
    files[`assets/${name}`] = path
  }
  const ui = directory ? directoryAssets(root) : embeddedAssets(files)
  const store = await openAuthStore({ filename: join(root, "auth.db") })
  const paired = await store.claimPairingCode({
    code: (await store.createPairingCode()).code,
    deviceName: "test browser",
  })
  if (!paired.success) throw new Error("pair failed")
  const gate = createWebGate({
    store,
    ui,
    secrets: createSecretStore({ dir: root, env: { TOURI_SECRETS_KEY: "test" } }),
    limiter: createRateLimiter({ maxFailures: 3, windowMs: 60_000 }),
  })
  type Handler = (request: Request, server: ReturnType<typeof Bun.serve>) => Promise<Response | undefined>
  let handle: Handler = async () => undefined
  const server = {
    port: 12345,
    requestIP: () => ({ address: "127.0.0.1" }),
    timeout: () => {},
    stop: () => {},
  } as unknown as ReturnType<typeof Bun.serve>
  // Exercise the real request handler without binding a listening socket.
  const serve = spyOn(Bun, "serve").mockImplementation((options) => {
    handle = options.fetch as Handler
    return server
  })
  const runtime = (() => {
    try {
      return createKernel({
        appData: root,
        ...(desktop
          ? {}
          : {
              web: {
                hostname: "127.0.0.1",
                port: 0,
                intercept: gate,
                host: () => async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "test" }),
              },
            }),
      })
    } finally {
      serve.mockRestore()
    }
  })()
  runtime.kernel.registerRoutes({
    name: "compression-test",
    routes: [
      { method: "GET", path: "/messages", handler: async () => ({ status: 200, json: payload }) },
      { method: "GET", path: "/small", handler: async () => ({ status: 200, json: { ok: true } }) },
      {
        method: "GET",
        path: "/stream",
        handler: async ({ query }) => ({
          status: 200,
          mime: query.mime ?? "text/event-stream",
          stream: new ReadableStream<Uint8Array>({
            start(out) {
              out.enqueue(new TextEncoder().encode(`data: ${script}\n\n`))
              out.close()
            },
          }),
        }),
      },
    ],
  })
  cleanups.push(async () => {
    runtime.stop()
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const call = async (path: string, encoding = "", method = "GET"): Promise<Response> => {
    const response = await handle(
      new Request(`http://127.0.0.1:${runtime.handshake.port}${path}`, {
        method,
        headers: {
          host: `127.0.0.1:${runtime.handshake.port}`,
          cookie: `touri_device=${paired.token}`,
          "Accept-Encoding": encoding,
          ...(desktop ? { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" } : {}),
        },
      }),
      server,
    )
    if (!response) throw new Error("missing response")
    return response
  }
  return { call, ui }
}

test.each(["gzip", "br"])("served UI and JSON use %s with correct wire headers", async (encoding) => {
  const { call } = await fixture()
  for (const [path, original] of [
    ["/assets/app.js", script],
    ["/api/v1/messages", JSON.stringify(payload)],
  ] as const) {
    const response = await call(path, encoding)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-encoding")).toBe(encoding)
    expect(response.headers.get("vary")).toContain("Accept-Encoding")
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length)
    expect(bytes.length).toBeLessThan(Buffer.byteLength(original))
    expect((encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString()).toBe(original)
  }
})

test("served responses keep identity without an accepted encoding", async () => {
  const { call } = await fixture()
  for (const encoding of ["", "identity", "gzip;q=0, br;q=0", "deflate"]) {
    const response = await call("/assets/app.js", encoding)
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(await response.text()).toBe(script)
    expect(response.headers.get("vary")).toContain("Accept-Encoding")
  }
})

test("small assets, images and SSE keep their original bodies", async () => {
  const { call } = await fixture()
  for (const [path, original] of [
    ["/assets/small.css", "body {}"],
    ["/assets/image.png", script],
    ["/api/v1/small", '{"ok":true}'],
    ["/api/v1/stream", `data: ${script}\n\n`],
    ["/api/v1/stream?mime=text/plain", `data: ${script}\n\n`],
  ] as const) {
    const response = await call(path, "gzip, br")
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(await response.text()).toBe(original)
  }
})

test("HEAD has the same representation headers as GET and no body", async () => {
  const { call } = await fixture()
  for (const encoding of ["", "gzip", "br"]) {
    const get = await call("/assets/app.js", encoding)
    const head = await call("/assets/app.js", encoding, "HEAD")
    expect(head.status).toBe(200)
    for (const header of ["content-type", "content-encoding", "content-length", "vary", "cache-control"])
      expect(head.headers.get(header)).toBe(get.headers.get(header))
    expect(await head.text()).toBe("")
    await get.arrayBuffer()
  }
})

test.each([
  ["gzip, br", "br"],
  ["gzip;q=1, br;q=0.5", "gzip"],
  ["gzip;q=0, br;q=0.5", "br"],
  ["br;q=0, *;q=0.5", "gzip"],
  ["GZIP; q=1", "gzip"],
  ["br;q=0.2, identity;q=1", null],
])("encoding negotiation honours %s", async (accepted, expected) => {
  const { call } = await fixture()
  const response = await call("/assets/app.js", accepted ?? "")
  expect(response.headers.get("content-encoding")).toBe(expected)
  await response.arrayBuffer()
})

test("embedded assets reuse both compressed variants across requests", async () => {
  const { call, ui } = await fixture()
  const asset = ui.get("assets/app.js")
  expect(asset).toBe(ui.get("assets/app.js"))
  if (!asset?.compressed) throw new Error("missing compression cache")
  const first = asset.compressed()
  expect(first).toBe(asset.compressed())
  const variants = await first
  for (const encoding of ["gzip", "br"] as const) {
    const response = await call("/assets/app.js", encoding)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(variants[encoding])
  }
})

test("desktop JSON responses retain identity even when compression is accepted", async () => {
  const { call } = await fixture({ desktop: true })
  const response = await call("/api/v1/messages", "gzip, br")
  expect(response.status).toBe(200)
  expect(response.headers.get("content-encoding")).toBeNull()
  expect(response.headers.get("vary")).toBe("Origin")
  expect(await response.json()).toEqual(payload)
})

test("directory UI assets are compressed using their current contents", async () => {
  const { call } = await fixture({ directory: true })
  const response = await call("/app.js", "gzip")
  expect(response.status).toBe(200)
  expect(response.headers.get("content-encoding")).toBe("gzip")
  expect(gunzipSync(await response.arrayBuffer()).toString()).toBe(script)
})

test("the compression threshold counts UTF-8 bytes", async () => {
  const request = new Request("https://app.example/asset", { headers: { "Accept-Encoding": "gzip" } })
  for (const size of [1023, 1024]) {
    const text = "é".repeat(511) + "a".repeat(size - 1022)
    const response = await compressBufferedResponse(
      request,
      new Response(text, { headers: { "Content-Type": "text/plain" } }),
    )
    expect(response.headers.get("content-encoding")).toBe(size === 1024 ? "gzip" : null)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect((size === 1024 ? gunzipSync(bytes) : bytes).toString()).toBe(text)
  }
})

test("304 and 204 responses stay bodyless without new representation headers", async () => {
  const request = new Request("https://app.example/asset", { headers: { "Accept-Encoding": "gzip, br" } })
  for (const status of [304, 204]) {
    const original = new Response(null, { status, headers: { ETag: '"asset"', Vary: "Origin" } })
    const response = await compressBufferedResponse(request, original)
    expect(response).toBe(original)
    expect(response.status).toBe(status)
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("vary")).toBe("Origin")
    expect(await response.text()).toBe("")
  }
})

test("compression preserves Vary and replaces the identity length", async () => {
  const request = new Request("https://app.example/asset", { headers: { "Accept-Encoding": "gzip" } })
  for (const vary of ["Origin", "*", "Origin, accept-encoding"]) {
    const response = await compressBufferedResponse(
      request,
      new Response(script, {
        headers: { "Content-Type": "application/json", "Content-Length": String(script.length), Vary: vary },
      }),
    )
    expect(response.headers.get("vary")).toBe(vary === "Origin" ? "Origin, Accept-Encoding" : vary)
    expect(Number(response.headers.get("content-length"))).toBe((await response.arrayBuffer()).byteLength)
  }
})

test.each(["font/woff2", "application/zip", "application/gzip", "text/event-stream"])(
  "%s responses bypass compression",
  async (mime) => {
    const request = new Request("https://app.example/asset", { headers: { "Accept-Encoding": "gzip, br" } })
    const original = new Response(script, { headers: { "Content-Type": mime } })
    expect(await compressBufferedResponse(request, original)).toBe(original)
    expect(await original.text()).toBe(script)
  },
)

test("encoded, partial and no-transform bodies bypass compression", async () => {
  const request = new Request("https://app.example/asset", { headers: { "Accept-Encoding": "gzip, br" } })
  for (const headers of [
    { "Content-Encoding": "gzip" },
    { "Content-Range": "bytes 0-5999/9000" },
    { "Cache-Control": "private, no-transform" },
  ]) {
    const original = new Response(script, { headers: { "Content-Type": "text/plain", ...headers } })
    expect(await compressBufferedResponse(request, original)).toBe(original)
    expect(await original.text()).toBe(script)
  }
})
