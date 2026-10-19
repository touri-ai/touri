import { AsyncLocalStorage } from "node:async_hooks"
import type { ApiRoutes, Kernel } from "@touri/contracts"
import type { Server } from "bun"
import type { SlowStatement, SqliteStatementTotals } from "./sqlite-performance"

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
  "store_transcript_startup_recovery",
  "database_page_maintenance",
  "storage_message_compaction_batch",
  "storage_vacuum",
  "storage_attachment_candidate_scan",
  "storage_attachment_reference_scan",
  "storage_attachment_orphan_scan",
  "notification_run_recovery_scan",
  "notification_journal_recovery_scan",
  "notification_routine_recovery_scan",
  "notification_recovery_reconcile",
  "notification_history_reconcile",
  "history_backfill_batch",
  "import_staging_expiry",
  "project_supervisor_ports",
  "project_supervisor_restart",
  "vm_idle_sweep",
  "vm_orphan_sweep",
  "device_revocation",
  "desktop_revocation",
  "computer_grant_expiry",
  "browser_session_save",
  "browser_session_key_retry",
  "message_search_index",
  "storage_upgrade_batch",
] as const

export type PerformanceStage = (typeof STAGES)[number]
type StageTiming = {
  stage: PerformanceStage
  calls: number
  totalMs: number
  maxMs: number
  asyncCalls?: number
  asyncMaxMs?: number
  pending?: number
  pendingMs?: number
}

export type PerformanceStageTracker = {
  run: PerformanceStageRunner
  getCurrentStage: () => PerformanceStage | undefined
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
  const currentStage = new AsyncLocalStorage<PerformanceStage>()
  const run = <Value, Input = undefined>(
    stage: PerformanceStage,
    action: (input: Input) => Value,
    input?: Input,
  ): Value => {
    // Validate at runtime too: diagnostics must never retain caller-controlled names or values.
    if (!Object.hasOwn(counters, stage)) return action(input as Input)

    const counter = counters[stage]
    if (!counter) return action(input as Input)

    return currentStage.run(stage, () => counter.run(action, input))
  }

  return {
    run,
    getCurrentStage: () => currentStage.getStore(),
    snapshot: () =>
      Object.values(counters)
        .map((counter) => counter.getTiming())
        .filter((timing) => timing.calls > 0 || timing.asyncCalls || timing.pending)
        .reduce(getRankedTimings, [] as Array<StageTiming>),
    reset: () =>
      Object.values(counters).forEach((counter) => {
        counter.reset()
      }),
  }
}

const createStageCounter = (stage: PerformanceStage, now: () => number) => {
  // Synchronous calls update numeric counters; asynchronous passes keep local lifetime markers.
  let calls = 0
  let totalMs = 0
  let maxMs = 0
  let asyncCalls = 0
  let asyncMaxMs = 0
  const pending = new Set<{ startedAt: number }>()
  const observeAsync = (result: unknown, startedAt: number): void => {
    if (!(result instanceof Promise)) return

    const operation = { startedAt }
    pending.add(operation)
    const finish = () => {
      pending.delete(operation)
      asyncCalls += 1
      asyncMaxMs = Math.max(asyncMaxMs, now() - startedAt)
    }
    // Async wall time includes I/O. Keep it separate from synchronous timings,
    // and retain completion after a sampler reset so continuations stay visible.
    void result.then(finish, finish)
  }
  const run = <Value, Input = undefined>(action: (input: Input) => Value, input?: Input): Value => {
    const startedAt = now()
    try {
      const result = action(input as Input)
      observeAsync(result, startedAt)
      return result
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
      ...(asyncCalls ? { asyncCalls, asyncMaxMs: getMilliseconds(asyncMaxMs) } : {}),
      ...(pending.size
        ? {
            pending: pending.size,
            pendingMs: getMilliseconds(
              now() - Array.from(pending).reduce((oldest, operation) => Math.min(oldest, operation.startedAt), now()),
            ),
          }
        : {}),
    }),
    reset: () => {
      calls = 0
      totalMs = 0
      maxMs = 0
      asyncCalls = 0
      asyncMaxMs = 0
    },
  }
}

const getRankedTimings = (ranked: Array<StageTiming>, timing: StageTiming): Array<StageTiming> => {
  const index = ranked.findIndex((entry) => getStageRank(timing) > getStageRank(entry))
  if (index < 0) return ranked.concat(timing).slice(0, 8)

  return ranked.slice(0, index).concat(timing, ranked.slice(index)).slice(0, 8)
}

const getStageRank = (timing: StageTiming): number =>
  Math.max(timing.totalMs, timing.asyncMaxMs ?? 0, timing.pendingMs ?? 0)

export const createPerformanceDiagnostics = ({
  log,
  getContext,
  now = performance.now.bind(performance),
  stageTracker,
  slowStatements,
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
  slowStatements?: {
    snapshot: () => Array<SlowStatement>
    snapshotTotals: () => SqliteStatementTotals
    reset: () => void
  }
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
    const slowStatementTimings = shouldWarn ? (slowStatements?.snapshot() ?? []) : []
    const sqliteStatementTotals = shouldWarn
      ? (slowStatements?.snapshotTotals() ?? { calls: 0, totalMs: 0 })
      : undefined
    stages.reset()
    slowStatements?.reset()
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
        slowStatements: slowStatementTimings,
        ...(sqliteStatementTotals ? { sqliteStatementTotals } : {}),
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
