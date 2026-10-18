import type { ApiRoutes, Kernel } from "@touri/contracts"
import type { Server } from "bun"

type EventLoopStats = NonNullable<ApiRoutes["GET /health"]["res"]["eventLoop"]>
type RequestTracker = { inFlight: Map<Request, number>; getRoute: (request: Request) => string }
type Context = { activeRuns: number; sseClients: number; websocketClients: number }
type FetchHandler<SocketData> = (request: Request, server: Server<SocketData>) => Promise<Response | undefined>
type StageTiming = { calls: number; totalMs: number; maxMs: number }
const MAX_TRACKED_STAGES = 16

export type PerformanceStageTracker = {
  run: PerformanceStageRunner
  snapshot: () => Array<{ stage: string; calls: number; totalMs: number; maxMs: number }>
  reset: () => void
}

export type PerformanceStageRunner = <Value>(stage: string, action: () => Value) => Value

export const createPerformanceStageTracker = (now = performance.now.bind(performance)): PerformanceStageTracker => {
  // A bounded map keeps timing updates constant work on the streaming path.
  const timings = new Map<string, StageTiming>()
  const run = <Value>(stage: string, action: () => Value): Value => {
    const startedAt = now()
    try {
      return action()
    } finally {
      const durationMs = now() - startedAt
      if (timings.has(stage) || timings.size < MAX_TRACKED_STAGES) {
        const previous = timings.get(stage) ?? { calls: 0, totalMs: 0, maxMs: 0 }
        timings.set(stage, {
          calls: previous.calls + 1,
          totalMs: previous.totalMs + durationMs,
          maxMs: Math.max(previous.maxMs, durationMs),
        })
      }
    }
  }

  return {
    run,
    snapshot: () =>
      [...timings]
        .map(([stage, timing]) => ({ stage, ...timing }))
        .sort((left, right) => right.totalMs - left.totalMs || right.maxMs - left.maxMs)
        .slice(0, 8)
        .map(({ stage, calls, totalMs, maxMs }) => ({
          stage,
          calls,
          totalMs: getMilliseconds(totalMs),
          maxMs: getMilliseconds(maxMs),
        })),
    reset: () => timings.clear(),
  }
}

export const createPerformanceDiagnostics = ({
  log,
  getContext,
  now = performance.now.bind(performance),
  stageTracker,
  sampleMs = 1_000,
  lagThresholdMs = 500,
  slowRequestMs = 2_000,
  cooldownMs = 60_000,
  startSampling = startInterval,
}: {
  log: Kernel["log"]
  getContext: () => Context
  now?: () => number
  stageTracker?: PerformanceStageTracker
  sampleMs?: number
  lagThresholdMs?: number
  slowRequestMs?: number
  cooldownMs?: number
  startSampling?: (sample: () => void, intervalMs: number) => () => void
}) => {
  // Timer and request lifetimes keep local state; requests are only read when a warning is written.
  const trackers = new Set<RequestTracker>()
  const stages = stageTracker ?? createPerformanceStageTracker(now)
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
    const stageTimings = stages.snapshot()
    stages.reset()
    if (lagMs < lagThresholdMs || at - lastLagWarningAt < cooldownMs) return

    lastLagWarningAt = at
    logWarning(() => ({
      level: "warn",
      module: "performance",
      msg: "Atraso no event loop",
      data: {
        eventLoop: getSnapshot(),
        ...getContext(),
        stages: stageTimings,
        inFlight: getSlowestRequests(trackers, at),
      },
    }))
  }
  const stopSampling = startSampling(sample, sampleMs)

  const finishRequest = (tracker: RequestTracker, request: Request, startedAt: number): void => {
    tracker.inFlight.delete(request)
    const at = now()
    const durationMs = at - startedAt
    if (stopped || durationMs <= slowRequestMs || at - lastRequestWarningAt < cooldownMs) return

    lastRequestWarningAt = at
    logWarning(() => ({
      level: "warn",
      module: "performance",
      msg: "Solicitação HTTP lenta",
      data: { ...getRequestLabel(tracker, request), durationMs: getMilliseconds(durationMs) },
    }))
  }

  const observeFetch = <SocketData>(
    handler: FetchHandler<SocketData>,
    getRoute: (request: Request) => string,
  ): FetchHandler<SocketData> => {
    // The fast path only records the start time; method and route are derived for warnings.
    const tracker: RequestTracker = { inFlight: new Map(), getRoute }
    trackers.add(tracker)

    return async (request, server) => {
      if (stopped) return handler(request, server)

      const startedAt = now()
      tracker.inFlight.set(request, startedAt)
      try {
        return await handler(request, server)
      } finally {
        finishRequest(tracker, request, startedAt)
      }
    }
  }

  const stop = (): void => {
    stopped = true
    stopSampling()
    trackers.forEach((tracker) => {
      tracker.inFlight.clear()
    })
  }

  return { getSnapshot, observeFetch, runStage: stages.run, stop }
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
const getSlowestRequests = (trackers: Set<RequestTracker>, at: number) =>
  [...trackers]
    .flatMap((tracker) => [...tracker.inFlight].map(([request, startedAt]) => ({ tracker, request, startedAt })))
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(0, 5)
    .map(({ tracker, request, startedAt }) => ({
      ...getRequestLabel(tracker, request),
      durationMs: getMilliseconds(at - startedAt),
    }))

const getRequestLabel = (tracker: RequestTracker, request: Request) => ({
  method: getMethod(request.method),
  route: tracker.getRoute(request),
})

const KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"])

const getMethod = (method: string): string => (KNOWN_METHODS.has(method) ? method : "OTHER")

const getMilliseconds = (value: number): number => Math.round(value * 1_000) / 1_000

const startInterval = (sample: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(sample, intervalMs)
  timer.unref()

  return () => clearInterval(timer)
}
