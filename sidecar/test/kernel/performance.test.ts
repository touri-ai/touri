import { afterEach, expect, mock, test } from "bun:test"
import type { Kernel } from "@touri/contracts"
import { createPerformanceDiagnostics } from "../../src/kernel/performance"
import { createRouteRegistry } from "../../src/kernel/routes"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test("a blocked event loop emits exactly one warning during the cooldown", async () => {
  const log = mock<Kernel["log"]>()
  const getContext = mock(() => ({ activeRuns: 3, sseClients: 2, websocketClients: 4 }))
  const diagnostics = createPerformanceDiagnostics({ log, getContext, sampleMs: 10, lagThresholdMs: 25 })
  cleanups.add(diagnostics.stop)

  blockLoop(70)
  await Bun.sleep(20)
  blockLoop(70)
  await Bun.sleep(20)

  expect(log).toHaveBeenCalledTimes(1)
  expect(getContext).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0]).toMatchObject({
    level: "warn",
    module: "performance",
    data: { activeRuns: 3, sseClients: 2, websocketClients: 4, inFlight: [] },
  })
  const stats = diagnostics.getSnapshot()
  expect(stats.maxMs).toBeGreaterThanOrEqual(25)
  expect(stats.p99Ms).toBeGreaterThanOrEqual(25)
})

test("the rolling window expires, recovers and permits a later warning", () => {
  const probe = makeProbe()

  probe.tick(1_600)
  const stalled = probe.diagnostics.getSnapshot()
  probe.tick(1_000)
  const recovered = probe.diagnostics.getSnapshot()
  probe.tick(60_000)
  probe.tick(1_000)

  expect(stalled).toEqual({ lagMs: 600, p99Ms: 600, maxMs: 600, samples: 1 })
  expect(recovered).toEqual({ lagMs: 0, p99Ms: 600, maxMs: 600, samples: 2 })
  expect(probe.log).toHaveBeenCalledTimes(2)
  expect(probe.diagnostics.getSnapshot()).toEqual({ lagMs: 0, p99Ms: 59_000, maxMs: 59_000, samples: 2 })
})

test("normal sampling stays silent and stop disposes the timer", () => {
  const probe = makeProbe()

  Array.from({ length: 100 }, () => probe.tick(1_000))
  probe.diagnostics.stop()
  probe.tick(10_000)

  expect(probe.log).not.toHaveBeenCalled()
  expect(probe.getContext).not.toHaveBeenCalled()
  expect(probe.stopSampling).toHaveBeenCalledTimes(1)
  expect(probe.diagnostics.getSnapshot().samples).toBeLessThanOrEqual(60)
})

test("slow requests use templates, rate limit across routes and clean up failures", async () => {
  const probe = makeProbe()
  const routes = createRouteRegistry()
  routes.registerRoutes({
    name: "fixture",
    routes: [{ method: "POST", path: "/threads/:id/messages", handler: async () => ({ status: 200, json: {} }) }],
  })
  const request = new Request("http://localhost/threads/private-id/messages?token=secret-query", {
    method: "POST",
    headers: { Authorization: "Bearer secret-header" },
    body: "secret-body",
  })
  const handler = probe.diagnostics.observeFetch<undefined>(
    async () => {
      probe.advance(2_001)
      throw new Error("secret-error")
    },
    (incoming) => routes.getTemplate(incoming.method, new URL(incoming.url).pathname) ?? "unmatched",
  )
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  cleanups.add(() => server.stop(true))

  await expect(handler(request, server)).rejects.toThrow("secret-error")
  const unmatched = new Request("http://localhost/private-unknown?secret-query", { method: "POST" })
  await expect(handler(unmatched, server)).rejects.toThrow("secret-error")
  probe.tick(1_600)

  expect(probe.log.mock.calls[0]?.[0]).toEqual({
    level: "warn",
    module: "performance",
    msg: "Slow HTTP request",
    data: { method: "POST", route: "/threads/:id/messages", durationMs: 2_001 },
  })
  expect(probe.log.mock.calls.filter(([entry]) => entry.msg === "Slow HTTP request")).toHaveLength(1)
  expect(probe.log.mock.calls.at(-1)?.[0].data?.inFlight).toEqual([])
  expect(JSON.stringify(probe.log.mock.calls)).not.toMatch(/private-id|secret-/)

  probe.advance(60_000)
  await expect(handler(unmatched, server)).rejects.toThrow("secret-error")

  expect(probe.log.mock.calls.at(-1)?.[0].data).toEqual({ method: "POST", route: "unmatched", durationMs: 2_001 })
  expect(probe.log.mock.calls.filter(([entry]) => entry.msg === "Slow HTTP request")).toHaveLength(2)
  expect(JSON.stringify(probe.log.mock.calls)).not.toContain("private-unknown")
})

test("lag warnings include only the five oldest in-flight templates", async () => {
  const probe = makeProbe()
  const release = Promise.withResolvers<Response>()
  const handler = probe.diagnostics.observeFetch<undefined>(
    async () => release.promise,
    () => "/threads/:id/runs",
  )
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  cleanups.add(() => server.stop(true))
  const requests = Array.from({ length: 8 }, (_, index) => {
    probe.advance(10)
    return handler(new Request(`http://localhost/threads/private-${index}/runs`), server)
  })

  probe.tick(1_600)
  release.resolve(new Response())
  await Promise.all(requests)

  const inFlight = probe.log.mock.calls[0]?.[0].data?.inFlight
  expect(inFlight).toEqual(
    [1_670, 1_660, 1_650, 1_640, 1_630].map((durationMs) => ({
      method: "GET",
      route: "/threads/:id/runs",
      durationMs,
    })),
  )
  expect(JSON.stringify(probe.log.mock.calls)).not.toContain("private-")
})

test("diagnostic failures preserve HTTP responses and keep timer callbacks safe", async () => {
  const probe = makeProbe()
  probe.log.mockImplementation(() => {
    throw new Error("Fixture log unavailable")
  })
  const response = new Response()
  const handler = probe.diagnostics.observeFetch<undefined>(
    async () => {
      probe.advance(2_001)
      return response
    },
    () => "/health",
  )
  const server = Bun.serve({ port: 0, fetch: () => response })
  cleanups.add(() => server.stop(true))

  const result = await handler(new Request("http://localhost/health"), server)

  expect(result).toBe(response)
  expect(() => probe.tick(1_600)).not.toThrow()
  probe.getContext.mockImplementation(() => {
    throw new Error("Fixture context unavailable")
  })

  expect(() => probe.tick(60_000)).not.toThrow()
  expect(probe.getContext).toHaveBeenCalledTimes(2)
})

test("request instrumentation has a small measured cost", async () => {
  const log = mock<Kernel["log"]>()
  const diagnostics = createPerformanceDiagnostics({
    log,
    getContext: () => ({ activeRuns: 0, sseClients: 0, websocketClients: 0 }),
  })
  cleanups.add(diagnostics.stop)
  const routes = createRouteRegistry()
  routes.registerRoutes({
    name: "fixture",
    routes: Array.from({ length: 200 }, (_, index) => ({
      method: "GET" as const,
      path: `/fixture-${index}/:id`,
      handler: async () => ({ status: 200, json: {} }),
    })),
  })
  const request = new Request("http://localhost/fixture-199/example?ignored=value")
  const response = new Response()
  const server = Bun.serve({ port: 0, fetch: () => response })
  cleanups.add(() => server.stop(true))
  const plain = async () => response
  const observed = diagnostics.observeFetch<undefined>(
    plain,
    (incoming) => routes.getTemplate(incoming.method, new URL(incoming.url).pathname) ?? "unmatched",
  )
  const iterations = 10_000

  const plainMs = await measure(iterations, plain)
  const observedMs = await measure(iterations, () => observed(request, server))
  const overheadUs = (Math.max(0, observedMs - plainMs) * 1_000) / iterations

  console.info(JSON.stringify({ iterations, plainMs, observedMs, overheadUs }))
  expect(overheadUs).toBeLessThan(250)
  expect(log).not.toHaveBeenCalled()
})

const makeProbe = () => {
  // A private clock and scheduler avoid patching process-wide timers.
  let at = 0
  let sample = () => {}
  const log = mock<Kernel["log"]>()
  const getContext = mock(() => ({ activeRuns: 0, sseClients: 0, websocketClients: 0 }))
  const stopSampling = mock(() => {})
  const diagnostics = createPerformanceDiagnostics({
    log,
    getContext,
    now: () => at,
    startSampling: (callback) => {
      sample = callback
      return stopSampling
    },
  })
  cleanups.add(diagnostics.stop)

  return {
    diagnostics,
    log,
    getContext,
    stopSampling,
    advance: (ms: number) => {
      at += ms
    },
    tick: (ms: number) => {
      at += ms
      sample()
    },
  }
}

const blockLoop = (ms: number): void => {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {}
}

const measure = async (iterations: number, request: () => Promise<unknown>): Promise<number> => {
  const startedAt = performance.now()
  for (let index = 0; index < iterations; index += 1) await request()

  return performance.now() - startedAt
}
