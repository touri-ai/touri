import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ApiRoutes, type RouteResponse, toolCatalog } from "@touri/contracts"
import type { WebSocketOptions } from "bun"
import { createKernel } from "../../src/kernel"
import { flushFileIoAsync } from "../../src/kernel/async-files"
import { socketTicket } from "../fakes/ws-ticket"

type Entry = { at: number; level: string; module: string; msg: string; data: Record<string, unknown> }
const FixtureSocket = WebSocket as { new (url: string, options?: string | string[] | WebSocketOptions): WebSocket }
const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("health includes bounded numeric lag stats without extra logs in normal operation", async () => {
  const fixture = makeServer()

  const response = await fixture.request("/health")
  const health = (await response.json()) as ApiRoutes["GET /health"]["res"]

  expect(response.status).toBe(200)
  expect(health.eventLoop).toEqual({ lagMs: 0, p99Ms: 0, maxMs: 0, samples: 0 })
  expect(await fixture.getLogs()).toEqual([])
})

test("lag logs count active runs and live clients and keep only route templates", async () => {
  const fixture = makeServer()
  const pending = Promise.withResolvers<RouteResponse>()
  const entered = Promise.withResolvers<void>()
  fixture.runtime.kernel.registerRoutes({
    name: "fixture",
    routes: [
      {
        method: "GET",
        path: "/threads/:id/pending",
        handler: async () => {
          entered.resolve()
          return pending.promise
        },
      },
      { method: "GET", path: "/fixture-events", handler: async ({ signal }) => getStreamResponse(signal) },
    ],
  })
  const database = fixture.runtime.kernel.db as Database
  seedRuns(database)
  expect(database.query("SELECT status FROM runs ORDER BY id").all()).toEqual([
    { status: "succeeded" },
    { status: "running" },
    { status: "starting" },
  ])
  const stream = await fixture.request("/fixture-events")
  cleanups.add(() => {
    void stream.body?.cancel()
  })
  const ticket = await socketTicket(fixture.runtime.handshake.port, "/api/v1/events")
  const socket = new FixtureSocket(`ws://127.0.0.1:${fixture.runtime.handshake.port}/api/v1/events?ticket=${ticket}`, {
    headers: { Origin: "tauri://localhost" },
  })
  cleanups.add(() => socket.close())
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }))
  const request = fixture.request("/threads/private-id/pending?secret=private-query")
  await entered.promise

  blockLoop(1_700)
  await Bun.sleep(25)
  const warnings = await fixture.getLogs()
  pending.resolve({ status: 200, json: {} })
  await request
  await stream.body?.cancel()
  socket.close()

  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toMatchObject({
    module: "performance",
    msg: "Atraso no event loop",
    data: {
      activeRuns: 2,
      sseClients: 1,
      websocketClients: 1,
      inFlight: [{ method: "GET", route: "/threads/:id/pending", durationMs: expect.any(Number) }],
    },
  })
  expect(JSON.stringify(warnings)).not.toMatch(/private-id|private-query/)
  const health = (await (await fixture.request("/health")).json()) as ApiRoutes["GET /health"]["res"]
  expect(health.eventLoop?.maxMs).toBeGreaterThanOrEqual(500)
}, 10_000)

test("HTTP requests over two seconds log once and long-lived streams stay quiet", async () => {
  const fixture = makeServer()
  fixture.runtime.kernel.registerRoutes({
    name: "fixture",
    routes: [
      { method: "GET", path: "/fixture-events", handler: async ({ signal }) => getStreamResponse(signal) },
      {
        method: "POST",
        path: "/threads/:id/messages",
        handler: async () => {
          await Bun.sleep(2_100)
          return { status: 200, json: {} }
        },
      },
    ],
  })
  const stream = await fixture.request("/fixture-events")
  cleanups.add(() => {
    void stream.body?.cancel()
  })

  await fixture.request("/threads/private-id/messages?secret=private-query", {
    method: "POST",
    body: JSON.stringify({ text: "private-body" }),
  })
  await fixture.request("/threads/another-id/messages", { method: "POST" })
  await stream.body?.cancel()

  expect(await fixture.getLogs()).toEqual([
    {
      module: "performance",
      msg: "Solicitação HTTP lenta",
      level: "warn",
      at: expect.any(Number),
      data: { method: "POST", route: "/threads/:id/messages", durationMs: expect.any(Number) },
    },
  ])
  expect(JSON.stringify(await fixture.getLogs())).not.toMatch(/private-|another-id/)
}, 10_000)

const makeServer = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-performance-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    await runtime.stop()
    await flushFileIoAsync()
    rmSync(root, { recursive: true, force: true })
  })
  const filename = join(runtime.kernel.paths.logsDir, "sidecar.log")

  return {
    runtime,
    request: (path: string, options: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${process.env.TOURI_UI_TOKEN ?? "dev-ui-token"}`,
          Origin: "tauri://localhost",
        },
      }),
    getLogs: async (): Promise<Array<Entry>> => {
      await flushFileIoAsync()
      if (!existsSync(filename)) return []

      return readFileSync(filename, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
        .filter((entry) => entry.module === "performance")
    },
  }
}

const seedRuns = (database: Database): void => {
  const provider = toolCatalog.tools.flatMap((tool) => {
    const metadata = tool["x-touri"]
    return "providers" in metadata ? metadata.providers : []
  })[0]
  if (!provider) throw new Error("Fixture provider unavailable")

  database
    .query(`INSERT INTO bots (id, name, provider, home_dir, created_at, updated_at)
    VALUES ('fixture-bot', 'Fixture', ?, '/tmp', 1, 1)`)
    .run(provider)
  database
    .query(`INSERT INTO threads (id, bot_id, title, created_at, updated_at)
    VALUES ('fixture-thread', 'fixture-bot', 'Fixture', 1, 1)`)
    .run()
  database
    .query(`INSERT INTO runs (id, thread_id, bot_id, provider, trigger, status, queued_at)
    VALUES ('fixture-starting', 'fixture-thread', 'fixture-bot', 'fixture', 'user', 'starting', 1),
      ('fixture-running', 'fixture-thread', 'fixture-bot', 'fixture', 'user', 'running', 1),
      ('fixture-done', 'fixture-thread', 'fixture-bot', 'fixture', 'user', 'succeeded', 1)`)
    .run()
}

const getStreamResponse = (signal: AbortSignal): RouteResponse => ({
  status: 200,
  mime: "text/event-stream",
  stream: new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(": ready\n\n"))
      signal.addEventListener("abort", () => controller.close(), { once: true })
    },
  }),
})

const blockLoop = (ms: number): void => {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {}
}
