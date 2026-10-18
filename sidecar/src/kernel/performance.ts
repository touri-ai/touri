import type { ApiRoutes, Kernel } from "@touri/contracts"
import type { Server } from "bun"

type EventLoopStats = NonNullable<ApiRoutes["GET /health"]["res"]["eventLoop"]>
type RequestTiming = { method: string; route: string; startedAt: number }
type Context = { activeRuns: number; sseClients: number; websocketClients: number }
type FetchHandler<SocketData> = (request: Request, server: Server<SocketData>) => Promise<Response | undefined>

export const createPerformanceDiagnostics = ({
  log,
  getContext,
  now = performance.now.bind(performance),
  sampleMs = 1_000,
  lagThresholdMs = 500,
  slowRequestMs = 2_000,
  cooldownMs = 60_000,
  startSampling = startInterval,
}: {
  log: Kernel["log"]
  getContext: () => Context
  now?: () => number
  sampleMs?: number
  lagThresholdMs?: number
  slowRequestMs?: number
  cooldownMs?: number
  startSampling?: (sample: () => void, intervalMs: number) => () => void
}) => {
  // Timer and request lifetimes keep local state; no request content is retained.
  const inFlight = new Map<symbol, RequestTiming>()
  let samples: Array<{ at: number; lagMs: number }> = []
  let expectedAt = now() + sampleMs
  let lastLagWarningAt = Number.NEGATIVE_INFINITY
  let lastRequestWarningAt = Number.NEGATIVE_INFINITY
  let stopped = false

  const logWarning = (getEntry: () => Parameters<Kernel["log"]>[0]): void => {
    try {
      log(getEntry())
    } catch {
      // Diagnostics must not fail requests or interrupt the server when logging is unavailable.
    }
  }

  const getSnapshot = (): EventLoopStats => getEventLoopStats(samples, now())
  const sample = (): void => {
    if (stopped) return

    const at = now()
    const lagMs = Math.max(0, at - expectedAt)
    expectedAt = at + sampleMs
    samples = [...samples.filter((item) => at - item.at < 60_000).slice(-59), { at, lagMs }]
    if (lagMs < lagThresholdMs || at - lastLagWarningAt < cooldownMs) return

    lastLagWarningAt = at
    logWarning(() => ({
      level: "warn",
      module: "performance",
      msg: "Event loop delayed",
      data: {
        eventLoop: getSnapshot(),
        ...getContext(),
        inFlight: getSlowestRequests(inFlight, at),
      },
    }))
  }
  const stopSampling = startSampling(sample, sampleMs)

  const finishRequest = (id: symbol, timing: RequestTiming): void => {
    inFlight.delete(id)
    const at = now()
    const durationMs = at - timing.startedAt
    if (stopped || durationMs <= slowRequestMs || at - lastRequestWarningAt < cooldownMs) return

    lastRequestWarningAt = at
    logWarning(() => ({
      level: "warn",
      module: "performance",
      msg: "Slow HTTP request",
      data: { method: timing.method, route: timing.route, durationMs: getMilliseconds(durationMs) },
    }))
  }

  const observeFetch = <SocketData>(
    handler: FetchHandler<SocketData>,
    getRoute: (request: Request) => string,
  ): FetchHandler<SocketData> => {
    return async (request, server) => {
      if (stopped) return handler(request, server)

      const id = Symbol()
      const timing = { method: getMethod(request.method), route: getRoute(request), startedAt: now() }
      inFlight.set(id, timing)
      try {
        return await handler(request, server)
      } finally {
        finishRequest(id, timing)
      }
    }
  }

  const stop = (): void => {
    stopped = true
    stopSampling()
    inFlight.clear()
  }

  return { getSnapshot, observeFetch, stop }
}

const getEventLoopStats = (samples: Array<{ at: number; lagMs: number }>, at: number): EventLoopStats => {
  const current = samples.filter((item) => at - item.at < 60_000)
  // The target library lacks toSorted; sorting a fresh snapshot keeps samples unchanged.
  const sorted = current.map((item) => item.lagMs).sort((left, right) => left - right)

  return {
    lagMs: getMilliseconds(current.at(-1)?.lagMs ?? 0),
    p99Ms: getMilliseconds(sorted[Math.ceil(sorted.length * 0.99) - 1] ?? 0),
    maxMs: getMilliseconds(sorted.at(-1) ?? 0),
    samples: current.length,
  }
}

// Only the fresh snapshot is sorted; live request tracking stays unchanged.
const getSlowestRequests = (inFlight: Map<symbol, RequestTiming>, at: number) =>
  [...inFlight.values()]
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(0, 5)
    .map(({ method, route, startedAt }) => ({ method, route, durationMs: getMilliseconds(at - startedAt) }))

const getMethod = (method: string): string =>
  ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"].includes(method) ? method : "OTHER"

const getMilliseconds = (value: number): number => Math.round(value * 1_000) / 1_000

const startInterval = (sample: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(sample, intervalMs)
  timer.unref()

  return () => clearInterval(timer)
}
