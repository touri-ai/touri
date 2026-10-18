import type { ApiRoutes, Kernel } from "@touri/contracts"
import type { Server } from "bun"

type EventLoopStats = NonNullable<ApiRoutes["GET /health"]["res"]["eventLoop"]>
type RequestTracker = { inFlight: Map<Request, number>; getRoute: (request: Request) => string }
type Context = { activeRuns: number; sseClients: number; websocketClients: number }
type FetchHandler<SocketData> = (request: Request, server: Server<SocketData>) => Promise<Response | undefined>
const STAGES = [
  "runtime_provider_event",
  "runtime_text_materialization",
  "stream_batch",
  "stream_journal_write",
  "stream_part_preparation",
  "stream_text_materialization",
  "transcript_journal_capture",
  "transcript_projection_checkpoint",
  "transcript_event_replay",
  "transcript_event_log_write",
  "transcript_retention",
  "workspace_snapshot",
  "workspace_event_serialization",
  "workspace_websocket_broadcast",
  "routine_scheduler_dispatch",
  "database_page_maintenance",
  "storage_message_compaction_batch",
  "storage_vacuum",
  "history_backfill_batch",
] as const

export type PerformanceStage = (typeof STAGES)[number]
type StageTiming = { stage: PerformanceStage; calls: number; totalMs: number; maxMs: number }

export type PerformanceStageTracker = {
  run: PerformanceStageRunner
  snapshot: () => Array<StageTiming>
  reset: () => void
}

export type PerformanceStageRunner = <Value, Input = undefined>(
  stage: PerformanceStage,
  action: (input: Input) => Value,
  input?: Input,
) => Value

export const createPerformanceStageTracker = (now = performance.now.bind(performance)): PerformanceStageTracker => {
  const counters = Object.fromEntries(STAGES.map((stage) => [stage, createStageCounter(stage, now)] as const))
  const run = <Value, Input = undefined>(
    stage: PerformanceStage,
    action: (input: Input) => Value,
    input?: Input,
  ): Value => {
    // Validate at runtime too: diagnostics must never retain caller-controlled names or values.
    if (!Object.hasOwn(counters, stage)) return action(input as Input)

    const counter = counters[stage]
    if (!counter) return action(input as Input)

    return counter.run(action, input)
  }

  return {
    run,
    snapshot: () =>
      Object.values(counters)
        .map((counter) => counter.getTiming())
        .filter((timing) => timing.calls > 0)
        .reduce(getRankedTimings, [] as Array<StageTiming>),
    reset: () =>
      Object.values(counters).forEach((counter) => {
        counter.reset()
      }),
  }
}

const createStageCounter = (stage: PerformanceStage, now: () => number) => {
  // Only numeric, closure-local counters change on the hot path; no per-call timing record is allocated.
  let calls = 0
  let totalMs = 0
  let maxMs = 0
  const run = <Value, Input = undefined>(action: (input: Input) => Value, input?: Input): Value => {
    const startedAt = now()
    try {
      return action(input as Input)
    } finally {
      const durationMs = now() - startedAt
      calls += 1
      totalMs += durationMs
      maxMs = Math.max(maxMs, durationMs)
    }
  }

  return {
    run,
    getTiming: (): StageTiming => ({
      stage,
      calls,
      totalMs: getMilliseconds(totalMs),
      maxMs: getMilliseconds(maxMs),
    }),
    reset: () => {
      calls = 0
      totalMs = 0
      maxMs = 0
    },
  }
}

const getRankedTimings = (ranked: Array<StageTiming>, timing: StageTiming): Array<StageTiming> => {
  const index = ranked.findIndex(
    (entry) => timing.totalMs > entry.totalMs || (timing.totalMs === entry.totalMs && timing.maxMs > entry.maxMs),
  )
  if (index < 0) return ranked.concat(timing).slice(0, 8)

  return ranked.slice(0, index).concat(timing, ranked.slice(index)).slice(0, 8)
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
    const shouldWarn = lagMs >= lagThresholdMs && at - lastLagWarningAt >= cooldownMs
    const stageTimings = shouldWarn ? stages.snapshot() : []
    stages.reset()
    if (!shouldWarn) return

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
