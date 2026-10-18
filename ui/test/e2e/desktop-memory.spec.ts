import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { type BrowserContext, expect, type Page, test } from "@playwright/test"
import { build } from "vite"
import { captureMemorySample, installMemoryCounters, takeHeapSnapshot } from "./desktop-memory-profile"

const run = promisify(execFile)
const repository = resolve(import.meta.dirname, "../../..")
const duration = Number(process.env.TOURI_DESKTOP_MEMORY_MS ?? 300_000)
const remote = process.env.TOURI_DESKTOP_MEMORY_URL
const output = process.env.TOURI_DESKTOP_MEMORY_OUTPUT ?? join(repository, "node_modules/.cache/desktop-memory")
const phase = process.env.TOURI_DESKTOP_MEMORY_PHASE ?? "sample"
const localUi = !remote || process.env.TOURI_DESKTOP_MEMORY_LOCAL_UI === "1"
const uiDir = join(repository, remote ? "ui/dist" : "node_modules/.cache/desktop-memory-ui")
const servers = new Set<ChildProcess>()
const pairedDevices = new Set<{ id: string; dataDir: string | undefined }>()

test.use({ trace: "off", viewport: { width: 1440, height: 900 } })
test.setTimeout(duration + 600_000)
test.afterEach(async () => {
  for (const server of servers) await stopServer(server)
  servers.clear()
  for (const device of pairedDevices) {
    await run("touri", ["devices", "revoke", device.id, ...(device.dataDir ? ["--data-dir", device.dataDir] : [])])
  }
  pairedDevices.clear()
})

test("desktop memory profile at one and five minutes", async ({ page, context }) => {
  test.skip(!process.env.TOURI_DESKTOP_MEMORY_PHASE, "Opt in to this production-build memory benchmark")
  await mkdir(output, { recursive: true })
  if (localUi && process.env.TOURI_DESKTOP_MEMORY_REUSE_BUILD !== "1") await buildProfileUi()
  const origin = remote ?? (await startPreview())
  if (remote) {
    // Fulfilled frontend assets have no network address space; allow the requested server's local feed.
    await context.grantPermissions(["local-network-access"], { origin })
    await pairReadOnly(page, context, origin)
  }
  if (remote && localUi) await serveLocalUi(page, origin)
  await page.addInitScript(installMemoryCounters)
  const sockets = { frames: 0, bytes: 0, connections: 0, ticketStatuses: [] as number[], errors: [] as string[] }
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/api/v1/ws-ticket") return

    sockets.ticketStatuses = [...sockets.ticketStatuses.slice(-9), response.status()]
  })
  page.on("websocket", (socket) => {
    sockets.connections++
    socket.on("socketerror", (error) => {
      const redacted = error.replace(/(?:wss?|https?):\/\/\S+/g, "[endpoint]")
      sockets.errors = [...sockets.errors.slice(-2), redacted]
    })
    socket.on("framereceived", ({ payload }) => {
      sockets.frames++
      sockets.bytes += Buffer.byteLength(payload)
    })
  })
  const wasmRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".wasm")) wasmRequests.push(request.url())
  })
  await page.goto(remote ? origin : `${origin}/test/e2e/desktop-memory-harness.html`)
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".bot-row,.composer-island textarea").first()).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => !document.hidden)).toBe(true)
  if (remote) {
    await expect
      .poll(() => sockets.frames, { timeout: 15_000 })
      .toBeGreaterThan(0)
      .catch((error: unknown) => {
        console.log(JSON.stringify({ eventStream: sockets }))
        throw error
      })
  }
  const cdp = await context.newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  const started = Date.now()
  const samples = []
  // Sequential samples are essential: another browser would distort memory and decoding pressure.
  for (const target of new Set([Math.min(60_000, duration), duration])) {
    await page.waitForTimeout(Math.max(0, target - (Date.now() - started)))
    const memory = await captureMemorySample(page, cdp, started)
    const snapshot = await takeHeapSnapshot(cdp, join(output, `${phase}-${target}.heapsnapshot`))
    const sample = { ...memory, snapshot, sockets: { ...sockets }, wasmRequests: wasmRequests.length }
    samples.push(sample)
    console.log(JSON.stringify(sample))
  }
  await writeFile(join(output, `${phase}.json`), JSON.stringify(samples, null, 2))
  if (remote) expect(sockets.frames).toBeGreaterThan(0)
  if (!remote) await page.locator(".message-scroll").screenshot({ path: join(output, `${phase}.png`) })
  if (process.env.TOURI_DESKTOP_MEMORY_EXPECT_NO_WASM === "1") {
    expect(wasmRequests).toHaveLength(0)
    expect(samples.at(-1)?.resources.wasmInstantiations).toBe(0)
    expect(samples.at(-1)?.snapshot.nativeBufferBytes).toBeLessThan(1024 * 1024)
  }
  expect(samples.at(-1)?.heap.usedSize).toBeLessThan(24 * 1024 * 1024)
})

const buildProfileUi = async () => {
  if (remote) {
    await run("bun", ["--cwd", "ui", "build"], { cwd: repository })
    console.log("UI production build: passed")
    return
  }

  await build({
    root: join(repository, "ui"),
    configFile: join(repository, "ui/vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: uiDir,
      rollupOptions: { input: join(repository, remote ? "ui/index.html" : "ui/test/e2e/desktop-memory-harness.html") },
    },
  })
}

const startPreview = async () => {
  const reservation = createServer()
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done))
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("Missing profiling port")

  await new Promise<void>((done) => reservation.close(() => done()))
  const origin = `http://127.0.0.1:${address.port}`
  const server = spawn(
    process.execPath,
    [
      join(repository, "node_modules/vite/bin/vite.js"),
      "preview",
      "--outDir",
      uiDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(address.port),
    ],
    {
      cwd: join(repository, "ui"),
      stdio: "ignore",
    },
  )
  servers.add(server)
  await expect
    .poll(async () =>
      fetch(`${origin}/test/e2e/desktop-memory-harness.html`)
        .then((response) => response.ok)
        .catch(() => false),
    )
    .toBe(true)
  return origin
}

const pairReadOnly = async (page: Page, context: BrowserContext, origin: string) => {
  const dataDir = process.env.TOURI_DESKTOP_MEMORY_DATA
  const pairing = await run("touri", ["pair", ...(dataDir ? ["--data-dir", dataDir] : [])])
  const code = pairing.stdout.match(/Pairing code: ([A-Z0-9-]+)/)?.[1]
  expect(Boolean(code), "A pairing code was generated").toBe(true)
  const paired = await context.request.post(`${origin}/pair`, {
    timeout: 15_000,
    headers: { Origin: origin },
    data: { code, name: "touri memory profile" },
  })
  expect(paired.ok()).toBe(true)
  const device = (await paired.json()) as { deviceId: string }
  pairedDevices.add({ id: device.deviceId, dataDir })
  await page.route(`${origin}/api/**`, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    // Tickets authenticate the read-only event stream; workspace writes remain blocked.
    const allowed = request.method() === "GET" || (request.method() === "POST" && path === "/api/v1/ws-ticket")
    if (allowed) return route.continue()

    return route.fulfill({ status: 403, json: { errorCode: "FORBIDDEN" } })
  })
}

const serveLocalUi = async (page: Page, origin: string) => {
  await page.route(`${origin}/`, (route) => route.fulfill({ path: join(uiDir, "index.html") }))
  await page.route(`${origin}/assets/**`, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)
    return route.fulfill({ path: join(uiDir, "assets", name ?? "") })
  })
}

const stopServer = async (server: ChildProcess) => {
  if (server.exitCode !== null) return

  const stopped = new Promise<void>((done) => server.once("exit", () => done()))
  server.kill("SIGTERM")
  await stopped
}
