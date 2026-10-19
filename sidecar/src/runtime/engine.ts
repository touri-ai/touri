import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import type {
  ApprovalPart,
  Bot,
  Id,
  Kernel,
  Message,
  MessagePart,
  ProviderAdapter,
  ProviderEvent,
  Result,
  Routine,
  RoutineContinuity,
  RoutineRun,
  Run,
  RunErrorClass,
  RunStatus,
  RunTrigger,
  RunUsage,
  ServiceMap,
  StoreApi,
  TextPart,
  Thread,
} from "@touri/contracts"
import { publicError } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { hasRecordedActions, refineErrorClass, safeRunFailure } from "@touri/contracts/run-failure"
import { createApprovalBridge } from "../approvals/bridge"
import { approvalOutcome } from "../approvals/outcome"
import { delegatedBot } from "../groups/security"
import { createGroupStore } from "../groups/store"
import { buildChildEnv } from "../kernel"
import { folderAccessUnavailable, folderGrantProblem, refreshHostFolderAccess } from "../kernel/folder-capability"
import { hasPathHistory } from "../kernel/message-path"
import type { PerformanceStage, PerformanceStageRunner } from "../kernel/performance"
import { providerProfileEnv } from "../kernel/provider-profiles"
import { redactStructured } from "../kernel/redact"
import { attachedServers, resolveAttachedMcp } from "../mcp/attached"
import { reapOrphanShims } from "../mcp/shim-registry"
import { mem0SessionAllowed } from "../mem0/session"
import { resolveMcpEndpoint } from "../platform/transport"
import { prepareLocalProviderLogin } from "../vm/local-provider-login"
import { ProviderLoginError } from "../vm/provider-login"
import { redactVmEvents } from "../vm/redact-events"
import { MachineServiceError } from "../vm/service-error"
import { VmStageError, vmStage } from "../vm/stage"
import { createClaudeAdapter } from "./claude/adapter"
import { createCodexAdapter } from "./codex/adapter"
import { COMMAND_OUTPUT_INTERVAL_MS, commandOutputTail } from "./command-output"
import { getDefaultMaxConcurrentRuns } from "./concurrency"
import {
  CONTINUATION_WINDOW_MS,
  type ContinuationReason,
  CRASH_ERROR_CLASSES,
  CRASH_RESUME_BACKOFF_MS,
  continuationMarkers,
  continuationPrompt,
  continuationReasonOf,
  createRunContinuations,
  MAX_AUTO_CONTINUATIONS,
  MAX_CRASH_CONTINUATIONS,
} from "./continuations"
import { csvInput } from "./csv-input"
import { type GoalDeadlineClock, startGoalDeadline } from "./goal-deadline"
import { createGoalRuntime, getGoalPrompt } from "./goals"
import { buildHandoffPacket } from "./handoff"
import { composeDeveloperInstructions } from "./instructions"
import { isMcpStartupError } from "./mcp-startup"
import { createRuntimeNotices } from "./notices"
import { createOpenCodeAdapter } from "./opencode/adapter"
import { createRuntimePersistence, type RuntimePersistence } from "./persistence"
import { reapProviderProcesses } from "./provider-processes"
import { formatRoutineTitle, nextCronSlot, parseCron, previousCronSlot, validTimezone } from "./routines/cron"
import { sessionFingerprint, workingDirectory } from "./session"
import { createToolResolutions } from "./tool-resolutions"
import { retryTransient } from "./transient-retry"
import { turnConclusion } from "./turn-conclusion"
import { bounded, randomHexToken, writePrivateFile } from "./utils"
import { startVmTurn } from "./vm-turn"
import { createWorkState, type WorkState } from "./work-state"

type RunState = {
  replyParentId?: Id | undefined
  text: string
  pendingText: Array<string>
  pendingPartText: Map<number, { type: "text" | "reasoning"; chunks: Array<string> }>
  textItemIds: Set<string>
  parts: Array<MessagePart>
  partIndices: Map<string, number>
  dirtyParts: Set<number>
  replyMessageId: Id | null
  turnStarted: boolean
  externalSessionId: string | null
  rolloutPath: string | null
  usage: RunUsage
  contextTokens: number | null
  contextWindow: number | null
  completionError: { errorClass: RunErrorClass; errorMessage: string | null } | null
  cancelRequested: boolean
  generation: number | null
  fingerprint: string | null
  continueAfterApproval: boolean
  outputTimer: ReturnType<typeof setTimeout> | null
  partPublishImmediate: ReturnType<typeof setImmediate> | null
  lastEventLivenessCheckAt: number
  lastOutputPublishedAt: number
}

type ContinuationPlan = { reason: ContinuationReason; originalRunId: Id }

const appendPendingText = (state: RunState, partIndex: number, type: "text" | "reasoning", delta: string): void => {
  const pending = state.pendingPartText.get(partIndex) ?? { type, chunks: [] }
  // Provider chunks append in-place so each token does constant work as the reply grows.
  pending.chunks.push(delta)
  state.pendingPartText.set(partIndex, pending)
  if (type === "text") state.pendingText.push(delta)
}

const getPartKey = (part: MessagePart): string | null => ("callId" in part ? `${part.type}\u0000${part.callId}` : null)

const materializePartText = (state: RunState, partIndex: number, runStage?: PerformanceStageRunner): void => {
  const pending = state.pendingPartText.get(partIndex)
  if (!pending) return
  const part = state.parts[partIndex]
  if (!part || (part.type !== "text" && part.type !== "reasoning")) return
  const materialize = (): void => {
    const current = state.parts[partIndex]
    if (!current || (current.type !== "text" && current.type !== "reasoning")) return
    state.parts[partIndex] = { ...current, text: current.text + pending.chunks.join("") }
    state.pendingPartText.delete(partIndex)
  }
  if (runStage) runStage("runtime_text_materialization", materialize)
  else materialize()
}

const materializePendingText = (state: RunState, runStage?: PerformanceStageRunner): void => {
  if (!state.pendingText.length && !state.pendingPartText.size) return
  const materialize = (): void => {
    if (state.pendingText.length) state.text += state.pendingText.join("")
    state.pendingText = []
    for (const [partIndex, pending] of state.pendingPartText) {
      const part = state.parts[partIndex]
      if (!part || (part.type !== "text" && part.type !== "reasoning")) continue
      state.parts[partIndex] = { ...part, text: part.text + pending.chunks.join("") }
    }
    state.pendingPartText.clear()
  }
  if (runStage) runStage("runtime_text_materialization", materialize)
  else materialize()
}

type PendingApproval = { runId: Id; provider: ProviderAdapter; providerApprovalId: Id }

const ROUTINE_TICK_GRACE_MS = 2 * 60_000
const EVENT_LIVENESS_CHECK_INTERVAL_MS = 50

type RoutineCreate = {
  botId: Id
  name: string
  prompt: string
  cron: string
  timezone: string
  enabled: boolean
  continuity: RoutineContinuity
  resultsThreadId: Id | null
  groupId: Id | null
  timeoutMinutes: number
  overlap: Routine["overlap"]
  catchUpMinutes: number
}

type RoutineUpdate = {
  routineId: Id
  patch: Partial<Routine>
  fromTool: boolean
  botId?: Id
}

type RuntimeEngine = {
  ready: Promise<void>
  goals: ReturnType<typeof createGoalRuntime>
  enqueue: (args: {
    threadId: Id
    requestMessageId: Id
    trigger: RunTrigger
    routineRunId?: Id
    delegated?: boolean
    continuing?: boolean
  }) => Result<{ run: Run }, "THREAD_NOT_FOUND" | "BOT_PAUSED" | "RUNTIME_DRAINING">
  getRunSnapshot: (run: Run) => Run
  getWorkRuns: () => Array<Run>
  settingsChanged: () => void
  listRuns: (threadId: Id, options?: { all?: boolean }) => Array<Run>
  activeRun: (args: { threadId: Id }) => Run | null
  continueAfterApproval: ServiceMap["runtime.continueAfterApproval"]
  cancel: (id: Id) => Result<{ run: Run }, "NOT_FOUND">
  cancelRuns: (runIds: Id[]) => Promise<void>
  cancelBotTurns: (args: { botId: Id }) => Promise<void>
  retry: (
    id: Id,
  ) => Result<{ run: Run }, "NOT_FOUND" | "THREAD_NOT_FOUND" | "BOT_PAUSED" | "CONFLICT" | "RUNTIME_DRAINING">
  answerApproval: (args: {
    approvalId: Id
    decision: "approved" | "denied"
    standing?: boolean
    message?: string
  }) => Promise<Result<object, "NOT_FOUND">>
  approvalBridge: ReturnType<typeof createApprovalBridge>
  approvalPrompt: (args: {
    ctx: { botId: Id; threadId: Id; runId: Id | null; signal: AbortSignal }
    toolName: string
    input: unknown
    toolUseId?: string
  }) => Promise<
    Result<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }, "NOT_FOUND" | "TIMEOUT" | "DENIED">
  >
  listRoutines: (botId?: Id) => Array<Routine>
  listRoutineRuns: (routineId: Id) => Array<RoutineRun>
  createRoutine: (args: {
    input: RoutineCreate
    forceDisabled: boolean
  }) => Result<{ routine: Routine }, "BOT_NOT_FOUND" | "INVALID_ARGS">
  updateRoutine: (args: {
    routineId: Id
    patch: Partial<Routine>
    fromTool: boolean
    botId?: Id
  }) => Result<{ routine: Routine }, "NOT_FOUND" | "NOT_OWNED" | "INVALID_ARGS">
  deleteRoutine: (routineId: Id) => Result<object, "NOT_FOUND">
  runRoutine: (args: {
    routineId: Id
    triggerSource: RoutineRun["triggerSource"]
    scheduledFor?: number
  }) => Result<
    { routineRun: RoutineRun },
    "NOT_FOUND" | "INVALID_ARGS" | "THREAD_NOT_FOUND" | "BOT_PAUSED" | "DELEGATION_LIMIT" | "RUNTIME_DRAINING"
  >
  tick: (now?: number) => Promise<void>
  beginDrain: () => void
  waitForDrain: () => Promise<void>
  shutdown: () => Promise<void>
}

const statusForError = (errorClass: RunErrorClass): RunStatus => {
  if (errorClass === "canceled") return "canceled"
  if (errorClass === "app_restart") return "interrupted"
  return "failed"
}

const initialUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: null,
  durationMs: 0,
  toolCalls: 0,
})

const routineError = (input: RoutineCreate): string | null => {
  if (
    !input.name.trim() ||
    input.name.length > 80 ||
    !input.prompt.trim() ||
    input.prompt.length > 8_000 ||
    !Number.isInteger(input.catchUpMinutes) ||
    input.catchUpMinutes < 0 ||
    input.catchUpMinutes > 1440 ||
    !Number.isInteger(input.timeoutMinutes) ||
    input.timeoutMinutes < 1 ||
    input.timeoutMinutes > 240
  )
    return "Invalid routine name, prompt or timeout"
  if (!(["skip", "queue"] as Array<Routine["overlap"]>).includes(input.overlap)) return "Invalid routine overlap"
  if (!validTimezone(input.timezone)) return "Invalid IANA timezone"
  const parsed = parseCron(input.cron)
  return parsed.success ? null : parsed.error
}

const cloneRun = (run: Run): Run => ({ ...run, usage: run.usage ? { ...run.usage } : null })

export const createRuntimeEngine = ({
  kernel,
  codexCommand,
  claudeCommand,
  opencodeCommand,
  environment,
  maxConcurrentRuns: configuredMaxConcurrentRuns,
  interruptGraceMs,
  routineTimeoutMs,
  resumeBackoffMs = CRASH_RESUME_BACKOFF_MS,
  providerAdapters,
  getNow = Date.now,
  goalDeadlineClock,
  runStage,
}: {
  kernel: Kernel
  codexCommand?: string
  claudeCommand?: string
  opencodeCommand?: string
  environment?: Record<string, string>
  maxConcurrentRuns?: number
  interruptGraceMs?: number
  routineTimeoutMs?: (routine: Routine) => number
  resumeBackoffMs?: number
  providerAdapters?: Partial<Record<Bot["provider"], ProviderAdapter>>
  getNow?: () => number
  goalDeadlineClock?: GoalDeadlineClock
  runStage?: PerformanceStageRunner
}): RuntimeEngine => {
  const runtimeStartedAt = getNow()
  const persistence: RuntimePersistence = createRuntimePersistence({ database: kernel.db })
  const ownerPath = `${kernel.paths.runDir}/runtime-owner`
  const owner = randomHexToken()
  writePrivateFile({ root: kernel.paths.appData, path: ownerPath, content: owner })
  const ownsRuntime = (): boolean => {
    try {
      return readFileSync(ownerPath, "utf8") === owner
    } catch {
      return false
    }
  }
  let queued: Array<Id> = persistence.listQueuedRuns().map((run) => run.id)
  let draining = false
  let shuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  const tools = createToolResolutions(kernel)
  const active = new Map<Id, Run>()
  const controllers = new Map<Id, AbortController>()
  const executions = new Map<Id, Promise<void>>()
  const providers = new Map<Id, ProviderAdapter>()
  const states = new Map<Id, RunState>()
  const pendingApprovals = new Map<Id, PendingApproval>()
  const measureStage = <Value>(stage: PerformanceStage, action: () => Value): Value =>
    runStage ? runStage(stage, action) : action()
  const codexOptions = {
    kernel,
    ...(runStage ? { runStage } : {}),
    ...(codexCommand ? { command: codexCommand } : {}),
    ...(interruptGraceMs === undefined ? {} : { interruptGraceMs }),
  }
  const claudeOptions = {
    kernel,
    ...(claudeCommand ? { command: claudeCommand } : {}),
    ...(interruptGraceMs === undefined ? {} : { interruptGraceMs }),
  }
  const adapters: Record<Bot["provider"], ProviderAdapter> = {
    codex: createCodexAdapter(codexOptions),
    claude: createClaudeAdapter(claudeOptions),
    opencode: createOpenCodeAdapter({
      kernel,
      ...(opencodeCommand ? { command: opencodeCommand } : {}),
      ...(interruptGraceMs === undefined ? {} : { interruptGraceMs }),
    }),
    ...providerAdapters,
  }
  const getMaxConcurrentRuns = (): number =>
    Math.max(
      1,
      configuredMaxConcurrentRuns ??
        kernel.services.use("store.settings")?.().maxConcurrentRuns ??
        getDefaultMaxConcurrentRuns(environment ?? process.env),
    )
  const routineTimeout = routineTimeoutMs ?? ((routine: Routine): number => routine.timeoutMinutes * 60_000)

  const notices = createRuntimeNotices({ kernel })
  const work: WorkState = createWorkState({ database: kernel.db as Database })
  const continuations = createRunContinuations({ database: kernel.db })
  const pendingContinuations = new Map<Id, { timer: ReturnType<typeof setTimeout>; run: Run; plan: ContinuationPlan }>()
  const goalDeadlines = new Map<Id, ReturnType<typeof startGoalDeadline>>()
  const getGoalNow = goalDeadlineClock?.now ?? Date.now
  const goals = createGoalRuntime(
    kernel,
    {
      enqueue: (threadId, requestMessageId) => {
        const result = enqueue({ threadId, requestMessageId, trigger: "retry" })
        return result.success ? result.run : null
      },
      cancel: (runId) => {
        cancel(runId)
      },
      getRuns: persistence.listRuns,
      isStopping: () => shuttingDown || draining,
      onSaved: (goal) => {
        if (goal.runId) goalDeadlines.get(goal.runId)?.setDeadline(goal.deadlineAt)
      },
    },
    getGoalNow,
  )

  const getQueuedRuns = (): Run[] => {
    const snapshots = new Map(persistence.getRunSnapshots(queued).map((run) => [run.id, run]))
    return queued.flatMap((id) => {
      const run = snapshots.get(id)
      return run?.status === "queued" && active.get(run.threadId)?.id !== id ? [run] : []
    })
  }

  const getQueueSnapshot = () => {
    const waiting = getQueuedRuns()
    return { waiting, positions: new Map(waiting.map((run, index) => [run.id, index + 1])) }
  }

  const getRunOrigin = (run: Run): NonNullable<Run["origin"]> => {
    if (run.origin) return run.origin
    if (continuations.link(run.id)) return "resume"
    if (!run.requestMessageId) return run.trigger === "routine" ? "routine" : "message"
    const stored =
      kernel.db instanceof Database
        ? (kernel.db
            .query(`
      SELECT sender_json IS NOT NULL AS delegated,
        EXISTS(SELECT 1 FROM json_each(parts_json)
          WHERE json_extract(value, '$.type') = 'notice'
            AND json_extract(value, '$.code') = 'run_resumed') AS resumed
      FROM messages WHERE id = ? AND thread_id = ?
    `)
            .get(run.requestMessageId, run.threadId) as { delegated: number; resumed: number } | null)
        : null
    if (stored?.resumed) return "resume"
    if (stored?.delegated) return "delegation"
    if (stored) return run.trigger === "routine" ? "routine" : "message"
    const request = kernel.services
      .use("store.api")
      ?.activePath({
        threadId: run.threadId,
        ...(run.requestMessageId ? { leafId: run.requestMessageId } : {}),
      })
      .find((message) => message.id === run.requestMessageId)
    if (request?.parts.some((part) => part.type === "notice" && part.code === "run_resumed")) return "resume"
    if (request?.sender) return "delegation"
    if (run.trigger === "routine") return "routine"
    return "message"
  }

  const getSnapshot = (run: Run, queue: ReturnType<typeof getQueueSnapshot>): Run => {
    const metadata =
      run.origin && run.groupThreadId !== undefined ? run : (persistence.getRunSnapshots([run.id])[0] ?? run)
    const groupThreadId =
      metadata.groupThreadId === undefined
        ? (kernel.services.use("store.api")?.getThread({ threadId: run.threadId })?.groupThreadId ?? null)
        : metadata.groupThreadId
    const position = run.status === "queued" ? queue.positions.get(run.id) : undefined

    return {
      ...cloneRun(run),
      groupThreadId,
      origin: getRunOrigin(metadata),
      queuePosition: position ?? null,
      queueTotal: position === undefined ? null : queue.waiting.length,
    }
  }
  const getRunSnapshot = (run: Run): Run => getSnapshot(run, getQueueSnapshot())
  const publishRun = (run: Run): void => kernel.publish({ type: "run.updated", run: getRunSnapshot(run) })
  const publishQueue = (): void => {
    const queue = getQueueSnapshot()
    queue.waiting.forEach((run) => {
      kernel.publish({ type: "run.updated", run: getSnapshot(run, queue) })
    })
  }
  const getWorkRuns = (): Run[] => {
    const queue = getQueueSnapshot()
    return persistence.listWorkRuns().map((run) => getSnapshot(run, queue))
  }

  const updateRun = (run: Run, patch: Partial<Run>): Run => {
    const leftQueue = run.status === "queued" && patch.status !== undefined && patch.status !== "queued"
    const next = { ...run, ...patch }
    if (!persistence.saveRun(next)) {
      const stored = persistence.getRun(run.id)
      if (stored) Object.assign(run, stored)
      return run
    }
    Object.assign(run, next)
    publishRun(run)
    if (leftQueue) publishQueue()
    return run
  }

  const isLive = (run: Run): boolean => {
    if (!ownsRuntime()) return false
    const stored = persistence.getRun(run.id)
    return stored !== null && ["queued", "starting", "running"].includes(stored.status)
  }

  const isLiveForEvent = (run: Run, state: RunState): boolean => {
    const now = performance.now()
    if (now - state.lastEventLivenessCheckAt < EVENT_LIVENESS_CHECK_INTERVAL_MS) return true

    // Provider frames arrive in bursts; a short lease avoids synchronous disk and SQLite reads per frame.
    state.lastEventLivenessCheckAt = now
    return isLive(run)
  }

  const finishLiveRun = (run: Run, finish: () => void): void => {
    // Accepted streaming work survives even if the final transaction rolls back.
    measureStage("runtime_stream_flush", () => kernel.services.use("store.api")?.flushWrites?.())
    const write = (): void => {
      if (!isLive(run)) return

      finish()
      tools.clearPending(run.id)
    }
    // The terminal reply, run and tool resolutions have one winning writer.
    if (kernel.db instanceof Database) kernel.db.transaction(write)()
    else write()
  }

  const getState = (runId: Id): RunState => {
    const state = states.get(runId)
    if (state) return state
    const created: RunState = {
      text: "",
      pendingText: [],
      pendingPartText: new Map(),
      textItemIds: new Set(),
      parts: [],
      partIndices: new Map(),
      dirtyParts: new Set(),
      replyMessageId: null,
      turnStarted: false,
      externalSessionId: null,
      rolloutPath: null,
      usage: initialUsage(),
      contextTokens: null,
      contextWindow: null,
      completionError: null,
      cancelRequested: false,
      generation: null,
      fingerprint: null,
      continueAfterApproval: false,
      outputTimer: null,
      partPublishImmediate: null,
      lastEventLivenessCheckAt: Number.NEGATIVE_INFINITY,
      lastOutputPublishedAt: 0,
    }
    states.set(runId, created)
    return created
  }

  const ensureReply = ({
    run,
    state,
    store,
    parentId,
  }: {
    run: Run
    state: RunState
    store: StoreApi
    parentId: Id
  }): void => {
    if (state.replyMessageId) return
    materializePendingText(state, runStage)
    const message: Omit<Message, "createdAt" | "updatedAt"> = {
      id: kernel.newId(),
      threadId: run.threadId,
      parentId: state.replyParentId ?? parentId,
      role: "assistant",
      kind: "text",
      status: "streaming",
      runId: run.id,
      text: state.text,
      parts: structuredClone(state.parts),
      sender: null,
      source: "local",
    }
    const result = store.insertMessage({ message })
    if (!result.success) return
    state.replyMessageId = result.message.id
    for (const index of state.dirtyParts) {
      const part = state.parts[index]
      if (part && !("callId" in part)) state.dirtyParts.delete(index)
    }
    run.replyMessageId = result.message.id
    persistence.saveRun(run)
  }

  const publishMessageNow = ({
    store,
    state,
    run,
    status,
  }: {
    store: StoreApi
    state: RunState
    run: Run
    status: Message["status"]
  }): void => {
    if (state.outputTimer) clearTimeout(state.outputTimer)
    state.outputTimer = null
    if (state.partPublishImmediate) clearImmediate(state.partPublishImmediate)
    state.partPublishImmediate = null
    state.lastOutputPublishedAt = Date.now()
    if (status === "streaming" && !state.cancelRequested)
      [...state.dirtyParts]
        .sort((left, right) => left - right)
        .forEach((partIndex) => {
          materializePartText(state, partIndex, runStage)
        })
    else materializePendingText(state, runStage)
    const partIndices = [...state.dirtyParts].sort((left, right) => left - right)
    const messageId = state.replyMessageId
    if (status === "streaming" && !messageId) return
    if (store.appendParts && status === "streaming") {
      if (!messageId) return
      const parts = measureStage("runtime_part_preparation", () =>
        partIndices.flatMap((partIndex) => {
          const part = state.parts[partIndex]
          if (!part) return []
          return [{ partIndex, part: "callId" in part ? tools.record(run, part, false, false) : part }]
        }),
      )
      if (parts.length) {
        measureStage("runtime_part_append", () =>
          store.appendParts?.({
            threadId: run.threadId,
            messageId,
            parts,
            ...(state.generation === null ? {} : { generation: state.generation }),
          }),
        )
        // The store can replace completed output with a durable attachment reference.
        for (const patch of parts) state.parts[patch.partIndex] = patch.part
        // Consent must be durable and visible before the approved action can proceed.
        if (parts.some(({ part }) => part.type === "approval"))
          measureStage("runtime_stream_flush", () => store.flushWrites?.())
      }
      partIndices.forEach((partIndex) => {
        state.dirtyParts.delete(partIndex)
      })
      return
    }
    if (!messageId) return
    const updated = measureStage("runtime_terminal_message_update", () =>
      store.updateMessage({
        threadId: run.threadId,
        messageId,
        patch: { status, parts: state.parts, text: state.text, runId: run.id },
      }),
    )
    if (updated.success) {
      state.parts = structuredClone(updated.message.parts)
      state.dirtyParts.clear()
    }
  }

  const finishParts = ({
    run,
    state,
    reason,
  }: {
    run: Run
    state: RunState
    reason: "cancelled_by_user" | "failed" | "interrupted_by_restart" | "unknown"
  }): void => {
    measureStage("runtime_part_finalization", () => {
      const parts = tools.finish(run, state.parts, reason)
      parts.forEach((part, index) => {
        const previous = state.parts[index]
        const entries = Object.entries(part)
        const changed =
          !previous ||
          entries.length !== Object.keys(previous).length ||
          entries.some(([key, value]) => Reflect.get(previous, key) !== value)
        if (changed) state.dirtyParts.add(index)
      })
      state.parts = parts
    })
  }

  const publishMessage = (args: { store: StoreApi; state: RunState; run: Run; status: Message["status"] }): void => {
    if (runStage) runStage("runtime_message_publish", publishMessageNow, args)
    else publishMessageNow(args)
  }

  const flushPendingPartPublish = ({ store, state, run }: { store: StoreApi; state: RunState; run: Run }): void => {
    if (state.partPublishImmediate === null) return
    clearImmediate(state.partPublishImmediate)
    state.partPublishImmediate = null
    if (shuttingDown || !isLiveForEvent(run, state)) return
    publishMessage({ store, state, run, status: "streaming" })
  }

  const schedulePartPublish = ({ store, state, run }: { store: StoreApi; state: RunState; run: Run }): void => {
    if (state.partPublishImmediate !== null) return
    state.partPublishImmediate = setImmediate(() => {
      state.partPublishImmediate = null
      if (shuttingDown || !isLiveForEvent(run, state)) return
      publishMessage({ store, state, run, status: "streaming" })
    })
  }

  const notice = ({
    store,
    run,
    parentId,
    part,
  }: {
    store: StoreApi
    run: Run
    parentId: Id
    part: Extract<MessagePart, { type: "notice" }>
  }): Id | null => {
    const result = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: run.threadId,
        parentId,
        role: "system",
        kind: "notice",
        status: "complete",
        runId: run.id,
        text: part.text,
        parts: [part],
        sender: null,
        source: "local",
      },
    })
    return result.success ? result.message.id : null
  }

  const makeMcpToken = (threadId: Id): { command: string; args: Array<string>; env: Record<string, string> } => {
    const tokenPath = `${kernel.paths.runDir}/mcp-tokens/${threadId}`
    writePrivateFile({ root: kernel.paths.appData, path: tokenPath, content: `${randomHexToken()}\n` })
    return {
      command: kernel.paths.sidecarBinary,
      args: ["mcp-stdio", "--thread", threadId],
      env: {
        TOURI_APP_DATA: kernel.paths.appData,
        TOURI_RUN_DIR: kernel.paths.runDir,
        TOURI_MCP_SOCK: resolveMcpEndpoint(kernel.paths),
      },
    }
  }

  const chooseCwd = async ({
    bot,
    thread,
  }: {
    bot: Bot
    thread: Thread
  }): Promise<{ cwd: string; projectDataDir: string | null }> => {
    return workingDirectory({ kernel, bot, thread })
  }

  const handleEvent = ({
    run,
    event,
    store,
    state,
  }: {
    run: Run
    event: ProviderEvent
    store: StoreApi
    state: RunState
  }): void => {
    if (shuttingDown) return
    // A newer runtime may have fenced this writer during restart recovery.
    if (!isLiveForEvent(run, state)) {
      controllers.get(run.id)?.abort()
      return
    }
    if (event.type === "session") {
      state.externalSessionId = event.externalSessionId
      state.rolloutPath = event.rolloutPath
      if (state.fingerprint) {
        continuations.saveResumePoint({
          runId: run.id,
          point: {
            externalSessionId: event.externalSessionId,
            rolloutPath: event.rolloutPath,
            fingerprint: state.fingerprint,
          },
        })
        // A turn can outlive the server. Ordinary follow-ups need this session too,
        // even when automatic continuation is disabled or unsafe.
        const current = persistence.getActiveSession({ threadId: run.threadId, provider: run.provider })
        const sameSession = current?.externalSessionId === event.externalSessionId
        if (current && !sameSession) persistence.markSession({ id: current.id, state: "replaced" })
        const now = Date.now()
        persistence.saveSession({
          id: sameSession ? current.id : kernel.newId(),
          threadId: run.threadId,
          provider: run.provider,
          externalSessionId: event.externalSessionId,
          rolloutPath: event.rolloutPath,
          fingerprint: state.fingerprint,
          state: "active",
          model: store.getBot({ botId: run.botId })?.model ?? null,
          createdAt: sameSession ? current.createdAt : now,
          lastUsedAt: now,
        })
      }
      return
    }
    if (event.type === "turn_started") {
      state.turnStarted = true
      updateRun(run, {
        status: "running",
        externalTurnId: event.externalTurnId,
        startedAt: run.startedAt ?? Date.now(),
      })
      return
    }
    if (event.type === "text_delta") {
      if (!event.delta) return
      if (!state.replyMessageId) {
        const thread = store.getThread({ threadId: run.threadId })
        const request = run.requestMessageId && thread ? getActivePathMessage({ store, run }) : null
        if (request) ensureReply({ run, state, store, parentId: request.id })
      }
      // Provider items are separate Markdown documents; chunks within an item are not.
      // Persist the separator as part of the delta so replay and crash recovery agree.
      const last = state.parts.at(-1)
      const hasText = state.text.length > 0 || state.pendingText.length > 0
      const separator = hasText && (!state.textItemIds.has(event.itemId) || last?.type !== "text") ? "\n\n" : ""
      state.textItemIds.add(event.itemId)
      const delta = separator + event.delta
      const existing = last?.type === "text" ? last : undefined
      const partIndex = existing ? state.parts.length - 1 : state.parts.length
      if (state.replyMessageId) flushPendingPartPublish({ store, state, run })
      if (!existing) state.parts.push({ type: "text", text: "" })
      if (state.cancelRequested) state.dirtyParts.add(partIndex)
      appendPendingText(state, partIndex, "text", delta)
      if (state.replyMessageId) {
        store.appendDelta({
          threadId: run.threadId,
          messageId: state.replyMessageId,
          partIndex,
          delta,
          ...(state.generation === null ? {} : { generation: state.generation }),
        })
      }
      return
    }
    if (event.type === "reasoning_delta" || event.type === "reasoning_progress") {
      if (event.type === "reasoning_delta" && !event.delta) return
      const last = state.parts.at(-1)
      const previous = last?.type === "reasoning" ? last : { type: "reasoning" as const, text: "" }
      const partIndex = last?.type === "reasoning" ? state.parts.length - 1 : state.parts.length
      if (event.type === "reasoning_progress") {
        const part = { ...previous, estimatedTokens: event.estimatedTokens }
        if (last?.type === "reasoning") state.parts[partIndex] = part
        else state.parts.push(part)
        state.dirtyParts.add(partIndex)
      } else {
        if (last?.type === "reasoning" && state.replyMessageId) {
          flushPendingPartPublish({ store, state, run })
          appendPendingText(state, partIndex, "reasoning", event.delta)
          store.appendDelta({
            threadId: run.threadId,
            messageId: state.replyMessageId,
            partIndex,
            delta: event.delta,
            ...(state.generation === null ? {} : { generation: state.generation }),
          })
          return
        }
        if (last?.type !== "reasoning") state.parts.push({ type: "reasoning", text: "" })
        appendPendingText(state, partIndex, "reasoning", event.delta)
        state.dirtyParts.add(partIndex)
      }
      if (state.replyMessageId) publishMessage({ store, state, run, status: "streaming" })
      else {
        const request = getActivePathMessage({ store, run })
        if (request) ensureReply({ run, state, store, parentId: request.id })
      }
      return
    }
    if (event.type === "item") {
      // Started, streamed input and completed frames describe the same call.
      // Redact before persistence or publication, including registered project secrets.
      const redacted = redactStructured(event.part, (text) => redactToolText(text, kernel.redact)) as MessagePart
      const part = Object.assign(redacted, {
        type: event.part.type,
        ...("callId" in event.part ? { callId: event.part.callId } : {}),
      })
      if (
        (part.type === "command" && part.exitCode === null) ||
        (part.type === "tool_call" && part.ok === null && part.outputTail !== undefined)
      )
        part.outputTail = commandOutputTail(part.outputTail ?? "")
      const key = getPartKey(part)
      const index = key ? (state.partIndices.get(key) ?? -1) : -1
      const previous = state.parts[index]
      if (previous?.type === "tool_call" && part.type === "tool_call") {
        state.parts[index] = {
          ...previous,
          ...part,
          inputJson: part.inputJson === "{}" ? previous.inputJson : part.inputJson,
          outputJson: part.outputJson ?? previous.outputJson,
          ok: part.ok ?? previous.ok,
          ...(previous.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        }
      } else if (previous?.type === "command" && part.type === "command") {
        state.parts[index] = {
          ...previous,
          ...part,
          command: part.command || previous.command,
          cwd: part.cwd || previous.cwd,
          outputTail: part.outputTail || previous.outputTail,
          exitCode: part.exitCode ?? previous.exitCode,
          ...(previous.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        }
      } else if (previous?.type === "file_change" && part.type === "file_change") {
        state.parts[index] = { ...previous, ...part, diff: part.diff ?? previous.diff }
      } else if (index >= 0) state.parts[index] = part
      else {
        state.parts.push(part)
        if (key) state.partIndices.set(key, state.parts.length - 1)
        if (part.type === "tool_call") state.usage.toolCalls += 1
      }
      const changedPartIndex = index >= 0 ? index : state.parts.length - 1
      state.dirtyParts.add(changedPartIndex)
      const changedPart = state.parts[changedPartIndex]
      if (state.cancelRequested && changedPart && "callId" in changedPart) {
        const pending =
          (changedPart.type === "tool_call" && changedPart.ok === null) ||
          (changedPart.type === "command" && changedPart.exitCode === null)
        state.parts[changedPartIndex] = tools.record(
          run,
          pending ? { ...changedPart, resolution: "cancelled_by_user", resolvedAt: Date.now() } : changedPart,
        )
      }
      if (!state.replyMessageId) {
        const thread = store.getThread({ threadId: run.threadId })
        const request = run.requestMessageId && thread ? getActivePathMessage({ store, run }) : null
        if (request) ensureReply({ run, state, store, parentId: request.id })
      }
      const liveOutput =
        previous &&
        ((part.type === "command" && part.exitCode === null) ||
          (part.type === "tool_call" && part.ok === null && part.outputTail !== undefined))
      const remaining = COMMAND_OUTPUT_INTERVAL_MS - (Date.now() - state.lastOutputPublishedAt)
      if (liveOutput && remaining > 0) {
        state.outputTimer ??= setTimeout(() => {
          state.outputTimer = null
          if (!shuttingDown && isLive(run)) publishMessage({ store, state, run, status: "streaming" })
        }, remaining)
        return
      }
      schedulePartPublish({ store, state, run })
      return
    }
    if (event.type === "approval_request") {
      if (event.part.decision === "expired") {
        for (const [approvalId, pending] of pendingApprovals) {
          if (pending.runId !== run.id || pending.providerApprovalId !== event.approvalId) continue
          pendingApprovals.delete(approvalId)
          const part = state.parts.find((part) => part.type === "approval" && part.approvalId === approvalId)
          if (part?.type === "approval") {
            part.decision = "expired"
            part.resolvedAt = Date.now()
            state.dirtyParts.add(state.parts.indexOf(part))
          }
          notices.resolve({ requestId: approvalId, resolution: "expired" })
        }
        if (state.replyMessageId) publishMessage({ store, state, run, status: "streaming" })
        return
      }
      if (run.provider === "claude" || run.provider === "opencode") {
        const signal = controllers.get(run.id)?.signal
        if (!signal) return
        const provider = providers.get(run.id) ?? adapters[run.provider]
        const scope = event.part.scope ?? { source: "claude" as const, tool: "Bash" }
        void approvalPrompt({
          ctx: { botId: run.botId, threadId: run.threadId, runId: run.id, signal },
          toolName: scope.tool,
          input: event.part.detail,
        })
          .then((result) =>
            provider.answerApproval({
              approvalId: event.approvalId,
              decision: result.success && result.behavior === "allow" ? "approved" : "denied",
              message: result.success
                ? (result.message ?? (result.behavior === "allow" ? approvalOutcome.once : approvalOutcome.denied))
                : result.error,
            }),
          )
          .catch(() => undefined)
        return
      }
      const approvalId = kernel.newId()
      state.parts.push({ ...event.part, approvalId, botId: run.botId, createdAt: event.part.createdAt ?? Date.now() })
      state.dirtyParts.add(state.parts.length - 1)
      notices.approval({
        botId: run.botId,
        threadId: run.threadId,
        requestId: approvalId,
        request: event.part.request,
        detail: event.part.detail,
        scope: event.part.scope,
      })
      if (!state.replyMessageId) {
        const thread = store.getThread({ threadId: run.threadId })
        const request = run.requestMessageId && thread ? getActivePathMessage({ store, run }) : null
        if (request) ensureReply({ run, state, store, parentId: request.id })
      }
      pendingApprovals.set(approvalId, {
        runId: run.id,
        providerApprovalId: event.approvalId,
        provider: providers.get(run.id) ?? adapters[run.provider],
      })
      if (state.replyMessageId) publishMessage({ store, state, run, status: "streaming" })
      return
    }
    if (event.type === "usage") {
      state.usage = { ...state.usage, ...event.usage }
      state.contextTokens = event.contextTokens
      state.contextWindow = event.contextWindow
      return
    }
    state.completionError = event.errorClass ? { errorClass: event.errorClass, errorMessage: event.errorMessage } : null
  }

  const getActivePathMessage = ({ store, run }: { store: StoreApi; run: Run }): Message | null => {
    if (!run.requestMessageId) return null
    if (store.getPathMessage) return store.getPathMessage({ threadId: run.threadId, messageId: run.requestMessageId })

    return store.activePath({ threadId: run.threadId }).find((message) => message.id === run.requestMessageId) ?? null
  }

  // Group coordination envelopes use the system role; failed member attempts alone leave no conversation to restore.
  const hasPreviousMessages = (store: StoreApi, thread: Thread, requestId: string | null): boolean => {
    if (store.getPathMessage && kernel.db instanceof Database && thread.activeLeafId)
      return hasPathHistory(kernel.db, thread.id, thread.activeLeafId, requestId)

    return store
      .activePath({ threadId: thread.id })
      .some((message) => message.id !== requestId && (message.role === "user" || message.role === "assistant"))
  }

  const finishRoutineRun = ({
    run,
    state,
    status,
    summary,
  }: {
    run: Run
    state: RunState
    status: RoutineRun["status"]
    summary?: string
  }): void => {
    if (!run.routineRunId) return
    const routineRun = persistence.getRoutineRun(run.routineRunId)
    if (!routineRun) return
    const finished: RoutineRun = {
      ...routineRun,
      status,
      summary: bounded({ value: summary ?? state.text, max: 500 }),
      finishedAt: Date.now(),
    }
    persistence.updateRoutineRun(finished)
    const routine = persistence.getRoutine(routineRun.routineId)
    if (routine) kernel.publish({ type: "routine.updated", routine, lastRun: finished })
  }

  // A group turn runs in the group runtime; its routine run closes here when the aggregate run ends.
  const finishGroupRoutineRun = (run: Run): void => {
    if (!run.routineRunId || ["queued", "starting", "running"].includes(run.status)) return
    if (!(kernel.db instanceof Database) || !kernel.db.query("SELECT 1 FROM group_turns WHERE run_id = ?").get(run.id))
      return
    const routineRun = persistence.getRoutineRun(run.routineRunId)
    const routine = routineRun ? persistence.getRoutine(routineRun.routineId) : null
    if (!routineRun || !routine || routineRun.status !== "running") return
    const store = kernel.services.use("store.api")
    const path = store?.activePath({ threadId: run.threadId }) ?? []
    const replies = path
      .slice(path.findIndex((message) => message.id === run.requestMessageId) + 1)
      .filter((message) => message.role === "assistant" && message.text.trim())
      .map((message) => `${message.sender?.name ?? "bot"}: ${message.text.trim()}`)
    const status: RoutineRun["status"] =
      run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "canceled"
    const summary =
      run.errorClass === "app_restart"
        ? "Interrupted because touri restarted"
        : (run.errorMessage ?? (replies.join("\n\n") || "Turno do grupo concluído"))
    const finished: RoutineRun = {
      ...routineRun,
      status,
      summary: bounded({ value: summary, max: 500 }),
      finishedAt: run.finishedAt ?? Date.now(),
    }
    persistence.updateRoutineRun(finished)
    kernel.publish({ type: "routine.updated", routine, lastRun: finished })
    if (status === "failed")
      notices.failure({ botId: routine.botId, threadId: run.threadId, routine: true, reason: summary })
  }
  // Minimal test kernels have no event bus; they also have no group runtime.
  const unsubscribeGroupTurns =
    typeof kernel.subscribe === "function"
      ? kernel.subscribe(({ event }) => {
          if (event.type === "run.updated") finishGroupRoutineRun(event.run)
        })
      : () => {}

  const execute = async (run: Run): Promise<void> => {
    if (!isLive(run)) {
      active.delete(run.threadId)
      return
    }
    const store = kernel.services.use("store.api")
    if (!store) {
      updateRun(run, {
        status: "failed",
        errorClass: "unknown",
        errorMessage: "Conversation store unavailable",
        finishedAt: Date.now(),
      })
      return
    }
    await tools.reconcilePending(store, run.threadId)
    if (!isLive(run)) {
      active.delete(run.threadId)
      return
    }
    const thread = store.getThread({ threadId: run.threadId })
    const ownBot = thread ? store.getBot({ botId: thread.botId }) : null
    const candidateBot = thread && ownBot ? delegatedBot(kernel, thread.id, ownBot) : null
    if (!thread || !candidateBot) {
      updateRun(run, {
        status: "failed",
        errorClass: "unknown",
        errorMessage: "Thread or bot not found",
        finishedAt: Date.now(),
      })
      return
    }
    const state = getState(run.id)
    // Full access has no folder restriction: a saved grant must never degrade it.
    const grantsApply =
      candidateBot.machine === "local" &&
      candidateBot.access !== "full" &&
      (!!candidateBot.anyFolderAccess || !!candidateBot.folders?.length)
    if (grantsApply) await refreshHostFolderAccess()
    const conversationOnly = grantsApply && !!folderGrantProblem(candidateBot)
    const bot: Bot = conversationOnly
      ? {
          ...candidateBot,
          folders: [],
          anyFolderAccess: false,
          access: "read-only",
          projectId: null,
          cwd: null,
          mcpServers: [],
          browserEnabled: false,
          computerUse: false,
        }
      : candidateBot
    if (conversationOnly) {
      state.replyParentId =
        notice({
          store,
          run,
          parentId: run.requestMessageId ?? thread.activeLeafId ?? run.id,
          part: {
            type: "notice",
            level: "warning",
            code: "folder_access_unavailable",
            text:
              candidateBot.anyFolderAccess || candidateBot.folders?.length
                ? "As permissões de pastas salvas não funcionam neste computador. Você pode conversar sem ferramentas. Remova essas permissões nas configurações do bot para continuar com tarefas."
                : folderAccessUnavailable,
          },
        }) ?? undefined
    }
    const request = getActivePathMessage({ store, run })
    const resumedFrom = request?.role === "system" ? continuationReasonOf(request.text) : null
    const link = continuations.link(run.id)
    const originalRun = link ? persistence.getRun(link.originalRunId) : null
    const previousRun = link ? persistence.getRun(link.previousRunId) : null
    const precedingRun = persistence
      .listRuns(thread.id)
      .find((attempt) => attempt.id !== run.id && attempt.status !== "queued")
    const unacceptedRequest =
      !resumedFrom &&
      precedingRun?.errorClass === "app_restart" &&
      precedingRun.externalTurnId === null &&
      precedingRun.requestMessageId !== request?.id
        ? getActivePathMessage({ store, run: precedingRun })
        : null
    // A session can be saved before the provider accepts the first turn. The bounded
    // carryover alone cannot deliver that request's full text or attachments after a restart.
    const originalRequest =
      originalRun &&
      (resumedFrom === "permission_granted" ||
        (resumedFrom === "app_restart" && originalRun.externalTurnId === null && previousRun?.externalTurnId === null))
        ? getActivePathMessage({ store, run: originalRun })
        : null
    const requestText = resumedFrom
      ? [continuationPrompt(resumedFrom), originalRequest ? `Original request:\n${originalRequest.text}` : null]
          .filter(Boolean)
          .join("\n\n")
      : [
          unacceptedRequest ? `Original request (interrupted before acceptance):\n${unacceptedRequest.text}` : null,
          request?.text,
        ]
          .filter(Boolean)
          .join("\n\n")
    const carryover = thread.carryoverNote
    if (carryover) store.updateThread({ threadId: thread.id, patch: { carryoverNote: null } })
    const toolSummary = tools.summary(store, thread.id, request?.id)
    // Optional Mem0 recall rides on this turn's input only: the stored message stays as the user wrote it.
    // Private memories never reach group or delegated sessions, routines, retries or continuations.
    const mem0 = kernel.services.use("mem0.api")
    const remembers =
      !!mem0 &&
      !!request &&
      request.role === "user" &&
      !resumedFrom &&
      run.trigger === "user" &&
      mem0SessionAllowed(kernel, thread.id) &&
      bot.machine !== "cloud" &&
      mem0.enabled(bot.id)
    let recalled: string | null = null
    if (remembers && request) {
      const recallController = new AbortController()
      controllers.set(run.id, recallController)
      try {
        recalled = await mem0.recall({ botId: bot.id, query: request.text, signal: recallController.signal })
      } finally {
        controllers.delete(run.id)
      }
    }
    const goal = goals.getForRun(run.id)
    const inputText = [recalled, carryover, toolSummary, requestText, goal ? getGoalPrompt(goal) : null]
      .filter(Boolean)
      .join("\n\n")
    const goalRequest = goal
      ? getActivePathMessage({ store, run: { ...run, requestMessageId: goal.requestMessageId } })
      : null
    const requestParts = unacceptedRequest
      ? [...unacceptedRequest.parts, ...(request?.parts ?? [])]
      : ((goalRequest ?? originalRequest ?? request)?.parts ?? [])
    const input: Array<TextPart | Extract<MessagePart, { type: "image" }>> = request
      ? [
          { type: "text", text: inputText },
          ...csvInput({ kernel, parts: requestParts }),
          ...requestParts.filter((part): part is Extract<MessagePart, { type: "image" }> => part.type === "image"),
        ]
      : [{ type: "text", text: inputText }]
    const { cwd, projectDataDir } =
      bot.machine === "vm"
        ? { cwd: "/workspace", projectDataDir: "/workspace/.touri/data" }
        : await chooseCwd({ bot, thread })
    if (shuttingDown || !isLive(run)) {
      active.delete(run.threadId)
      if (!shuttingDown) void drain()
      return
    }
    // Session identity is stable across run credentials. The actual per-run MCP
    // arguments returned by prepareTurn are supplied to the adapter below.
    const mcp =
      bot.machine === "vm"
        ? { command: "/usr/local/bin/node", args: ["/usr/local/lib/touri/mcp-stdio.cjs", thread.id], env: {} }
        : makeMcpToken(thread.id)
    const mcpFingerprint = sessionFingerprint({
      bot: {
        ...bot,
        mcpServers:
          delegatedBot(kernel, thread.id, { ...bot, mcpServers: attachedServers(kernel, bot.id) }).mcpServers ?? [],
      },
      cwd,
      mcpCommand: mcp.command,
      mcpArgs: mcp.args,
    })
    // Older versions saved the first session only as a per-run resume point.
    // Adopt it for a manual follow-up as well as for automatic continuations.
    if (!persistence.getActiveSession({ threadId: thread.id, provider: bot.provider })) {
      if (precedingRun?.provider === bot.provider && precedingRun.errorClass === "app_restart")
        adoptResumeSession(precedingRun)
    }
    const previousSession = persistence.getActiveSession({ threadId: thread.id, provider: bot.provider })
    let session = previousSession
    let handoffPacket: string | null = null
    const restoreContext = (reason: string): void => {
      if (!handoffPacket)
        state.replyParentId =
          notice({
            store,
            run,
            parentId: state.replyParentId ?? run.requestMessageId ?? thread.activeLeafId ?? run.id,
            part: {
              type: "notice",
              level: "info",
              code: "context_restored",
              text: "O contexto da conversa foi recuperado do histórico salvo.",
            },
          }) ?? state.replyParentId
      handoffPacket = buildHandoffPacket({ kernel, thread, reason })
    }
    if (unacceptedRequest) restoreContext("app restarted before the original turn was accepted")
    const previousAttempt =
      run.trigger === "retry"
        ? persistence
            .listRuns(thread.id)
            .find((attempt) => attempt.id !== run.id && attempt.requestMessageId === run.requestMessageId)
        : null
    if (previousAttempt?.errorClass === "app_restart") {
      // An interrupted native turn may not be resumable, even without a rollout path.
      // The persisted transcript is the reliable context after reopening the app.
      if (session) persistence.markSession({ id: session.id, state: "replaced" })
      session = null
      restoreContext("app restarted during the previous turn")
      handoffPacket = bounded({
        value: [
          "Continue from the partial transcript. Check the recorded work and current state before repeating actions; finish the user's original request.",
          handoffPacket,
        ].join("\n"),
        max: 32_000,
      })
    }
    if (session && session.fingerprint !== mcpFingerprint.hash && session.fingerprint !== "imported") {
      persistence.markSession({ id: session.id, state: "replaced" })
      restoreContext("session fingerprint changed")
      notice({
        store,
        run,
        parentId: run.requestMessageId ?? thread.activeLeafId ?? run.id,
        part: {
          type: "notice",
          level: "info",
          code: "session_replaced",
          text: "The native provider session was replaced and a handoff was supplied.",
        },
      })
      session = null
    }
    if (!session && !handoffPacket && hasPreviousMessages(store, thread, request?.id ?? null))
      restoreContext("native session unavailable")
    const baseEnvironment = bot.machine === "vm" ? {} : environment?.PATH ? environment : await kernel.shellEnv()
    const env = buildChildEnv({
      base: baseEnvironment,
      overrides: {
        ...environment,
        ...providerProfileEnv({ appData: kernel.paths.appData, bot }),
        TOURI_RUN_DIR: kernel.paths.runDir,
        TOURI_APP_DATA: kernel.paths.appData,
        ...(bot.machine === "vm" ? {} : { TOURI_MCP_SOCK: resolveMcpEndpoint(kernel.paths) }),
        ...(projectDataDir ? { TOURI_PROJECT_DATA_DIR: projectDataDir } : {}),
      },
    })
    if (shuttingDown || !isLive(run)) {
      active.delete(run.threadId)
      if (!shuttingDown) void drain()
      return
    }
    updateRun(run, { status: "starting", startedAt: run.startedAt ?? Date.now() })
    state.generation = store.getThread({ threadId: thread.id })?.generation ?? null
    state.fingerprint = mcpFingerprint.hash
    const controller = new AbortController()
    controllers.set(run.id, controller)
    const provider = adapters[bot.provider]
    providers.set(run.id, provider)
    active.set(run.threadId, run)
    const routineRun = run.routineRunId ? persistence.getRoutineRun(run.routineRunId) : null
    const routine = routineRun ? persistence.getRoutine(routineRun.routineId) : null
    const deadline = routine
      ? setTimeout(
          () => {
            if (run.status !== "starting" && run.status !== "running") return
            const currentState = getState(run.id)
            currentState.completionError = {
              errorClass: "timeout",
              errorMessage: `Routine exceeded its ${routine.timeoutMinutes}-minute timeout`,
            }
            controller.abort()
          },
          Math.max(1, routineBudget({ run, routine, routineRun })),
        )
      : null
    const result = await (async (): Promise<Awaited<ReturnType<ProviderAdapter["startTurn"]>>> => {
      let prepared: Awaited<ReturnType<import("@touri/contracts").VmRuntime["prepareTurn"]>> | undefined
      let flushEvents: (() => void) | undefined
      let releaseLogin: (() => void) | undefined
      try {
        if (bot.machine !== "vm" && bot.machine !== "cloud") {
          const login = await prepareLocalProviderLogin(kernel, bot, controller.signal, env.HOME)
          Object.assign(env, login.env)
          releaseLogin = login.release
        }
        if (bot.machine === "vm") {
          const vm = kernel.services.use("vm.runtime")
          if (!vm) return { success: false, errorCode: "cli_crash", error: "VM runtime indisponível" }
          const token = randomHexToken()
          const preparation = await retryTransient({
            run: () =>
              vm
                .prepareTurn({ botId: bot.id, threadId: thread.id, token, signal: controller.signal })
                .then((value) => ({ value, failure: null }))
                .catch((error: unknown) => ({ value: null, failure: error })),
            failureOf: (outcome) =>
              outcome.failure && !(outcome.failure instanceof MachineServiceError)
                ? outcome.failure instanceof Error
                  ? outcome.failure.message
                  : String(outcome.failure)
                : null,
            canRetry: () => !controller.signal.aborted,
            signal: controller.signal,
          })
          if (preparation.failure) throw preparation.failure
          prepared = preparation.value ?? undefined
          if (controller.signal.aborted)
            return { success: false, errorCode: "canceled", error: "Turno cancelado durante início da máquina" }
        }
        const prepareInstructions = async (signal?: AbortSignal) => {
          signal?.throwIfAborted()
          const turnBot = delegatedBot(kernel, thread.id, {
            ...(prepared?.bot ?? bot),
            mcpServers: conversationOnly ? [] : await resolveAttachedMcp(kernel, prepared?.bot ?? bot),
          })
          signal?.throwIfAborted()
          const turnInstructions = await composeDeveloperInstructions({
            kernel,
            bot: turnBot,
            thread,
            cwd,
            ...(signal ? { signal } : {}),
          })
          return { turnBot, turnInstructions }
        }
        const { turnBot, turnInstructions } = prepared
          ? await vmStage({
              kernel,
              botId: bot.id,
              threadId: thread.id,
              stage: "exec",
              timeoutMs: 30_000,
              timeoutMessage: "A preparação do CLI na máquina excedeu 30 s",
              signal: controller.signal,
              action: prepareInstructions,
            })
          : await prepareInstructions()
        const turnEnv = prepared?.env ?? env
        const dispatchEvent = (event: ProviderEvent) => handleEvent({ run, event, store, state })
        const emit = (event: ProviderEvent) =>
          runStage ? runStage("runtime_provider_event", dispatchEvent, event) : dispatchEvent(event)
        const safeEvents = redactVmEvents({ secrets: [], redact: kernel.redact, emit })
        flushEvents = safeEvents.flush
        // VM preparation registers its credentials with the same live registry.
        // Keep a single stream boundary for native and guest turns, before storage.
        const onEvent = safeEvents
        const startTurn: ProviderAdapter["startTurn"] = prepared
          ? (args) => startVmTurn({ kernel, provider, args })
          : provider.startTurn
        const invoke = (): ReturnType<typeof startTurn> => {
          // Completion diagnostics belong to one attempt; cancellation keeps its own cause.
          if (!controller.signal.aborted) state.completionError = null

          // Publish before invocation: startup and a silent provider are different waits.
          if (!run.providerStartedAt) updateRun(run, { providerStartedAt: Date.now() })
          return startTurn({
            ...(conversationOnly ? { conversationOnly: true } : {}),
            thread,
            bot: turnBot,
            session,
            fingerprint: mcpFingerprint.fingerprint,
            input,
            developerInstructions: turnInstructions,
            handoffPacket,
            mcp: prepared?.mcp ?? mcp,
            env: turnEnv,
            ...(prepared ? { execution: prepared.execution } : {}),
            onEvent,
            signal: controller.signal,
          })
        }
        const invokeWithRetry = (): ReturnType<typeof startTurn> =>
          retryTransient({
            run: invoke,
            failureOf: (outcome) => {
              if (!outcome.success) return outcome.error
              if (outcome.status !== "failed") return null

              // A processed completion frame can still report a failed provider turn.
              return state.completionError?.errorMessage ?? null
            },
            canRetry: () => !state.turnStarted && state.parts.length === 0,
            signal: controller.signal,
          })
        let providerResult = await invokeWithRetry()
        if (
          !providerResult.success &&
          session &&
          providerResult.errorCode === "cli_protocol" &&
          !isMcpStartupError(providerResult.error) &&
          !state.turnStarted &&
          !controller.signal.aborted
        ) {
          persistence.markSession({ id: session.id, state: "failed" })
          restoreContext("native session could not be resumed")
          session = null
          providerResult = await invokeWithRetry()
        }
        return providerResult
      } catch (error) {
        return {
          success: false,
          errorCode:
            error instanceof VmStageError || error instanceof MachineServiceError
              ? error.errorCode
              : error instanceof ProviderLoginError
                ? "cli_auth"
                : "cli_crash",
          error: kernel.redact(error instanceof Error ? error.message : String(error)),
        }
      } finally {
        // A completion frame is advisory; drain trailing text before publishing a terminal reply.
        flushEvents?.()
        await prepared?.release()
        releaseLogin?.()
        if (deadline) clearTimeout(deadline)
      }
    })()
    const finalizeProviderTurn = (): void => {
      approvalBridge.cancelRun(run.id)
      for (const [approvalId, approval] of pendingApprovals) {
        if (approval.runId !== run.id) continue
        pendingApprovals.delete(approvalId)
        notices.resolve({ requestId: approvalId, resolution: "expired" })
        const approvalIndex = state.parts.findIndex(
          (part) => part.type === "approval" && part.approvalId === approvalId,
        )
        const part = state.parts[approvalIndex]
        if (part?.type === "approval") {
          part.decision = "expired"
          part.resolvedAt = Date.now()
          state.dirtyParts.add(approvalIndex)
        }
      }
      if (!isLive(run)) {
        active.delete(run.threadId)
        controllers.delete(run.id)
        providers.delete(run.id)
        void drain()
        return
      }
      const elapsed = Date.now() - (run.startedAt ?? Date.now())
      state.usage.durationMs = elapsed
      if (result.success) {
        state.externalSessionId = state.externalSessionId ?? result.externalSessionId
        state.rolloutPath = state.rolloutPath ?? result.rolloutPath
        const sessionRow = persistence.getActiveSession({ threadId: thread.id, provider: bot.provider }) ??
          session ?? {
            id: kernel.newId(),
            threadId: thread.id,
            provider: bot.provider,
            externalSessionId: state.externalSessionId,
            rolloutPath: state.rolloutPath,
            fingerprint: mcpFingerprint.hash,
            state: "active",
            model: bot.model,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          }
        persistence.saveSession({
          ...sessionRow,
          externalSessionId: state.externalSessionId,
          rolloutPath: state.rolloutPath,
          fingerprint: mcpFingerprint.hash,
          state: "active",
          lastUsedAt: Date.now(),
        })
        const providerErrorClass = state.cancelRequested
          ? "canceled"
          : (state.completionError?.errorClass ?? (result.status === "succeeded" ? null : "cli_crash"))
        const workRoot = providerErrorClass ? null : work.publishRoot({ turnId: run.id })
        const errorClass = workRoot && !workRoot.success ? "tool_error" : providerErrorClass
        if (!errorClass) {
          const plan = state.continueAfterApproval
            ? planContinuation({ run, reason: "permission_granted", lastActivityAt: Date.now() })
            : null
          state.continueAfterApproval = false
          finishLiveRun(run, () => {
            ensureReply({ run, state, store, parentId: run.requestMessageId ?? thread.activeLeafId ?? run.id })
            finishParts({ run, state, reason: "unknown" })
            const conclusion = turnConclusion({
              parts: state.parts,
              requestText: (originalRequest ?? request)?.text ?? "",
              pendingPartText: state.pendingPartText,
            })
            if (conclusion)
              handleEvent({
                run,
                store,
                state,
                event: { type: "text_delta", itemId: kernel.newId(), delta: conclusion },
              })
            publishMessage({ store, state, run, status: "complete" })
            updateRun(run, {
              status: "succeeded",
              errorClass: null,
              errorMessage: null,
              usage: state.usage,
              finishedAt: Date.now(),
            })
            if (plan) scheduleContinuation({ run, plan })
            else {
              if (remembers && request)
                mem0?.sync({ botId: bot.id, threadId: thread.id, userText: request.text, assistantText: state.text })
              finishRoutineRun({ run, state, status: "succeeded" })
              if (goals.getForRun(run.id)?.status !== "active")
                notices.done({
                  botId: run.botId,
                  threadId: run.threadId,
                  summary: state.text,
                  routine: run.trigger === "routine" || run.routineRunId !== null,
                })
            }
          })
        } else {
          failTurn({
            run,
            state,
            store,
            thread,
            errorClass,
            errorMessage:
              workRoot && !workRoot.success
                ? "Não foi possível publicar o registro de efeitos do turno"
                : (state.completionError?.errorMessage ?? "Provider turn failed"),
          })
        }
      } else {
        failTurn({
          run,
          state,
          store,
          thread,
          errorClass: state.cancelRequested ? "canceled" : (state.completionError?.errorClass ?? result.errorCode),
          errorMessage: result.error,
        })
      }
      active.delete(run.threadId)
      controllers.delete(run.id)
      providers.delete(run.id)
      void drain()
    }
    if (runStage) runStage("runtime_turn_finalization", finalizeProviderTurn)
    else finalizeProviderTurn()
  }

  const finalizeFailure = ({
    run,
    state,
    store,
    thread,
    errorClass: reportedErrorClass,
    errorMessage,
    continuing = false,
  }: {
    run: Run
    state: RunState
    store: StoreApi
    thread: Thread
    errorClass: RunErrorClass
    errorMessage: string
    continuing?: boolean
  }): void => {
    const errorClass = refineErrorClass(reportedErrorClass, errorMessage)
    finishLiveRun(run, () => {
      finishParts({
        run,
        state,
        reason:
          errorClass === "canceled"
            ? "cancelled_by_user"
            : errorClass === "app_restart"
              ? "interrupted_by_restart"
              : "failed",
      })
      state.parts = state.parts.map((part, index) => {
        if (part.type !== "approval" || part.decision !== "pending") return part
        pendingApprovals.delete(part.approvalId)
        notices.resolve({ requestId: part.approvalId, resolution: "deny" })
        state.dirtyParts.add(index)
        return { ...part, decision: "expired", resolvedAt: Date.now() }
      })
      const safeError = bounded({ value: kernel.redact(errorMessage), max: 2_000 })
      kernel.log({
        level: errorClass === "canceled" ? "info" : "error",
        module: run.provider,
        msg: "Falha no turno",
        data: { botId: run.botId, threadId: run.threadId, runId: run.id, errorClass, error: safeError },
      })
      ensureReply({ run, state, store, parentId: run.requestMessageId ?? thread.activeLeafId ?? run.id })
      const noticeCode =
        errorClass === "canceled" ? "run_canceled" : errorClass === "app_restart" ? "app_restart" : "run_failed"
      const friendlyError = publicError(errorClass)
      const failure = safeRunFailure(errorClass, safeError)
      const friendlyMessage = isMcpStartupError(safeError)
        ? failure.detail
        : `${failure.detail} [${friendlyError.code}]`
      const noticeIndex = state.parts.length
      state.parts.push({
        type: "notice",
        level: errorClass === "canceled" ? "info" : "error",
        code: noticeCode,
        ...(noticeCode === "run_failed" ? { failure } : {}),
        text: errorClass === "canceled" ? "Cancelado por você" : `${errorClass}: ${friendlyMessage}`,
      })
      state.dirtyParts.add(noticeIndex)
      publishMessage({ store, state, run, status: statusForError(errorClass) === "canceled" ? "canceled" : "failed" })
      const carryover = state.turnStarted
        ? `[touri: your previous turn ended with ${errorClass}. Partial output: "${bounded({ value: state.text, max: 1_500 })}"]`
        : `[touri: your previous turn did not run (${errorClass}: ${safeError}). The user's message was: "${bounded({ value: getActivePathMessage({ store, run })?.text ?? "", max: 1_500 })}"]`
      store.updateThread({ threadId: thread.id, patch: { carryoverNote: carryover } })
      updateRun(run, {
        status: statusForError(errorClass),
        errorClass,
        errorMessage: safeError,
        usage: state.usage,
        finishedAt: Date.now(),
      })
      if (continuing) return
      finishRoutineRun({
        run,
        state,
        status: errorClass === "canceled" || errorClass === "app_restart" ? "canceled" : "failed",
        summary: state.text || `${errorClass}: ${safeError}`,
      })
      if (errorClass === "canceled" || errorClass === "app_restart") return
      notices.failure({
        botId: run.botId,
        threadId: run.threadId,
        routine: run.routineRunId !== null,
        reason: friendlyMessage,
      })
    })
  }

  const resumeEnabled = (): boolean => {
    if (!(kernel.db instanceof Database)) return true
    try {
      const row = kernel.db.query("SELECT value_json FROM settings WHERE key = 'resumeInterruptedTurns'").get() as {
        value_json: string
      } | null
      return row === null || row.value_json !== "false"
    } catch {
      return true
    }
  }

  const routineTimeLeft = ({ routine, routineRun }: { routine: Routine; routineRun: RoutineRun }): number =>
    routineTimeout(routine) - (Date.now() - (routineRun.startedAt ?? Date.now()))

  // A continuation shares the routine's original deadline instead of starting a new one.
  const routineBudget = ({
    run,
    routine,
    routineRun,
  }: {
    run: Run
    routine: Routine
    routineRun: RoutineRun | null
  }): number =>
    routineRun && continuations.link(run.id) ? routineTimeLeft({ routine, routineRun }) : routineTimeout(routine)

  // A routine canceled by a graceful quit is reopened by its continuation.
  const routineAllowsContinuation = (run: Run): boolean => {
    if (!run.routineRunId) return true
    const routineRun = persistence.getRoutineRun(run.routineRunId)
    const routine = routineRun ? persistence.getRoutine(routineRun.routineId) : null
    const open =
      routineRun?.status === "running" || (routineRun?.status === "canceled" && run.errorClass === "app_restart")
    return (
      !!routine && !!routineRun && open && routineRun.runId === run.id && routineTimeLeft({ routine, routineRun }) > 0
    )
  }

  const hasUncertainWork = (runId: Id): boolean =>
    work.rebuild({ turnId: runId }).some((effect) => effect.state === "uncertain" && !effect.acknowledged)

  const planContinuation = ({
    run,
    reason,
    lastActivityAt,
  }: {
    run: Run
    reason: ContinuationReason
    lastActivityAt: number
  }): ContinuationPlan | null => {
    if (shuttingDown || Date.now() - lastActivityAt > CONTINUATION_WINDOW_MS) return null
    if (reason !== "permission_granted" && !resumeEnabled()) return null
    if (!run.requestMessageId || continuations.isGroupRun(run.id)) return null
    const originalRunId = continuations.link(run.id)?.originalRunId ?? run.id
    const interruptedContinuations =
      continuations.count({ originalRunId, reason: "app_restart" }) +
      continuations.count({ originalRunId, reason: "provider_crash" })
    if (reason !== "permission_granted" && interruptedContinuations >= MAX_AUTO_CONTINUATIONS) return null
    if (reason === "provider_crash" && continuations.count({ originalRunId, reason }) >= MAX_CRASH_CONTINUATIONS)
      return null
    // Effects whose outcome is unknown wait for the user; the work notice already explains them.
    if (hasUncertainWork(run.id)) return null
    if (reason !== "permission_granted") {
      const parts =
        kernel.services
          .use("store.api")
          ?.activePath({ threadId: run.threadId })
          .filter((message) => message.runId === run.id)
          .flatMap((message) => message.parts) ?? []
      if (hasRecordedActions(parts)) return null
    }
    const session =
      continuations.resumePoint(run.id) ??
      persistence.getActiveSession({ threadId: run.threadId, provider: run.provider })
    const bot = kernel.services.use("store.api")?.getBot({ botId: run.botId })
    if ((!session && reason !== "permission_granted") || !bot || bot.paused || bot.machine === "cloud") return null
    return routineAllowsContinuation(run) ? { reason, originalRunId } : null
  }

  // Resume the exact provider session the interrupted turn was using.
  const adoptResumeSession = (run: Run): void => {
    const point = continuations.resumePoint(run.id)
    if (!point) return
    const current = persistence.getActiveSession({ threadId: run.threadId, provider: run.provider })
    if (current?.externalSessionId === point.externalSessionId) return
    if (current) persistence.markSession({ id: current.id, state: "replaced" })
    const now = Date.now()
    persistence.saveSession({
      id: kernel.newId(),
      threadId: run.threadId,
      provider: run.provider,
      externalSessionId: point.externalSessionId,
      rolloutPath: point.rolloutPath,
      fingerprint: point.fingerprint,
      state: "active",
      model: kernel.services.use("store.api")?.getBot({ botId: run.botId })?.model ?? null,
      createdAt: now,
      lastUsedAt: now,
    })
  }

  const startContinuation = ({ run, plan }: { run: Run; plan: ContinuationPlan }): boolean => {
    if (!routineAllowsContinuation(run)) return false
    const goal = goals.getForRun(run.id)
    if (goal && !goals.prepareContinuation(goal)) return false
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId: run.threadId })
    if (!store || !thread) return false
    adoptResumeSession(run)
    const part = {
      type: "notice" as const,
      level: "info" as const,
      code: "run_resumed" as const,
      text: continuationMarkers[plan.reason],
    }
    const marker = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: thread.id,
        parentId: run.replyMessageId ?? thread.activeLeafId,
        role: "system",
        kind: "notice",
        status: "complete",
        runId: null,
        text: part.text,
        parts: [part],
        sender: null,
        source: "local",
      },
    })
    if (!marker.success) return false
    const next = enqueue({
      threadId: thread.id,
      requestMessageId: marker.message.id,
      trigger: run.routineRunId ? "routine" : "retry",
      continuing: true,
      ...(run.routineRunId ? { routineRunId: run.routineRunId } : {}),
    })
    if (!next.success) return false
    if (!goals.attachRun(run.id, next.run.id)) {
      cancel(next.run.id)
      return false
    }
    continuations.record({
      runId: next.run.id,
      originalRunId: plan.originalRunId,
      previousRunId: run.id,
      reason: plan.reason,
      createdAt: Date.now(),
    })
    const routineRun = run.routineRunId ? persistence.getRoutineRun(run.routineRunId) : null
    const routine = routineRun ? persistence.getRoutine(routineRun.routineId) : null
    if (routineRun && routine) {
      const moved: RoutineRun = {
        ...routineRun,
        status: "running",
        runId: next.run.id,
        summary: null,
        finishedAt: null,
      }
      persistence.updateRoutineRun(moved)
      kernel.publish({ type: "routine.updated", routine, lastRun: moved })
    }
    kernel.log({
      level: "info",
      module: run.provider,
      msg: "Turno retomado automaticamente",
      data: {
        botId: run.botId,
        threadId: run.threadId,
        runId: next.run.id,
        previousRunId: run.id,
        reason: plan.reason,
      },
    })
    return true
  }

  // A routine run kept open for a continuation that did not start still needs its final state.
  const abandonContinuation = ({ run, status }: { run: Run; status: RoutineRun["status"] }): void => {
    const goal = goals.getForRun(run.id)
    if (!shuttingDown && goal?.status === "active") goals.saveGoal({ ...goal, status: "paused" })
    finishRoutineRun({ run, state: getState(run.id), status, summary: getState(run.id).text || "Turno interrompido" })
  }

  const scheduleContinuation = ({ run, plan }: { run: Run; plan: ContinuationPlan }): void => {
    const timer = setTimeout(
      () => {
        pendingContinuations.delete(run.id)
        const ready = !shuttingDown && canStartContinuation(run, plan)
        if (!ready || !startContinuation({ run, plan })) abandonContinuation({ run, status: "failed" })
      },
      plan.reason === "permission_granted" ? 0 : resumeBackoffMs,
    )
    pendingContinuations.set(run.id, { timer, run, plan })
  }

  const canStartContinuation = (run: Run, plan: ContinuationPlan): boolean =>
    ownsRuntime() &&
    (plan.reason === "permission_granted" || resumeEnabled()) &&
    // A newer user turn supersedes a continuation, including during shutdown.
    persistence.listRuns(run.threadId)[0]?.id === run.id

  const failTurn = ({
    run,
    state,
    store,
    thread,
    errorClass: reportedErrorClass,
    errorMessage,
  }: {
    run: Run
    state: RunState
    store: StoreApi
    thread: Thread
    errorClass: RunErrorClass
    errorMessage: string
  }): void => {
    const errorClass = refineErrorClass(reportedErrorClass, errorMessage)
    const crashed =
      CRASH_ERROR_CLASSES.includes(errorClass) && state.turnStarted && !state.cancelRequested && isLive(run)
    const plan = crashed ? planContinuation({ run, reason: "provider_crash", lastActivityAt: Date.now() }) : null
    finalizeFailure({ run, state, store, thread, errorClass, errorMessage, continuing: plan !== null })
    if (plan) scheduleContinuation({ run, plan })
  }

  const executeGoalTurn = async (run: Run): Promise<void> => {
    const goal = goals.getForRun(run.id)
    if (!goal) return execute(run)
    if (goal.status !== "active" || getGoalNow() >= goal.deadlineAt) {
      goals.expireRun(run.id)
      cancel(run.id)
      active.delete(run.threadId)
      void drain()
      return
    }
    const budgetTimer = startGoalDeadline(goal.deadlineAt, () => goals.expireRun(run.id), goalDeadlineClock)
    goalDeadlines.set(run.id, budgetTimer)
    try {
      await execute(run)
      const finished = persistence.getRun(run.id)
      if (!finished) return
      const state = getState(run.id)
      const needsReview =
        hasUncertainWork(run.id) || state.parts.some((part) => part.type === "approval" && part.decision !== "approved")
      goals.finishTurn(finished, state.text, pendingContinuations.has(run.id), needsReview)
    } finally {
      goalDeadlines.delete(run.id)
      budgetTimer.stop()
    }
  }

  const drain = async (): Promise<void> => {
    // A recovered turn must not run alongside the previous provider process.
    await startupCleanup
    while (!shuttingDown && ownsRuntime() && active.size < getMaxConcurrentRuns()) {
      const nextIndex = queued.findIndex((runId) => {
        const run = persistence.getRun(runId)
        return run !== null && !active.has(run.threadId) && (!draining || canDrainRun(run.id))
      })
      if (nextIndex < 0) return
      const runId = queued[nextIndex]
      queued = queued.filter((_, index) => index !== nextIndex)
      if (!runId) return
      const run = persistence.getRun(runId)
      if (run?.status !== "queued") continue
      active.set(run.threadId, run)
      updateRun(run, { status: "starting", startedAt: Date.now() })
      const execution = executeGoalTurn(run)
      executions.set(run.id, execution)
      void execution.finally(() => executions.delete(run.id)).catch(() => {})
    }
  }

  const enqueue = ({
    threadId,
    requestMessageId,
    trigger,
    routineRunId,
    delegated = false,
    continuing = false,
  }: {
    threadId: Id
    requestMessageId: Id
    trigger: RunTrigger
    routineRunId?: Id
    delegated?: boolean
    continuing?: boolean
  }): Result<{ run: Run }, "THREAD_NOT_FOUND" | "BOT_PAUSED" | "RUNTIME_DRAINING"> => {
    if (shuttingDown || (draining && !delegated && !continuing))
      return { success: false, errorCode: "RUNTIME_DRAINING", error: "O servidor está encerrando." }

    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId })
    const bot = thread ? store?.getBot({ botId: thread.botId }) : null
    if (!thread || !bot) return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Thread not found" }
    const activeRequest = persistence.findActiveRunForRequest({ threadId, requestMessageId })
    if (activeRequest) return { success: true, run: activeRequest }
    if (bot.paused || bot.machine === "cloud")
      return {
        success: false,
        errorCode: "BOT_PAUSED",
        error: bot.machine === "cloud" ? "Este bot usa o runtime remoto." : "Bot is paused",
      }
    if (trigger === "user") goals.pauseForUser(threadId)
    const run: Run = {
      id: kernel.newId(),
      threadId,
      botId: bot.id,
      provider: bot.provider,
      trigger,
      requestMessageId,
      replyMessageId: null,
      externalTurnId: null,
      status: "queued",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: routineRunId ?? null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    }
    persistence.saveRun(run)
    if (delegated) {
      publishRun(run)
      // A synchronous peer request cannot wait behind its caller's occupied slot.
      // Only group runtime uses this path; depth/call/cycle limits bound extra work.
      queueMicrotask(() => {
        if (shuttingDown) return

        if (active.has(threadId)) {
          cancel(run.id)
          return
        }
        active.set(threadId, run)
        const execution = executeGoalTurn(run)
        executions.set(run.id, execution)
        void execution.finally(() => executions.delete(run.id)).catch(() => {})
      })
    } else {
      queued = [...queued, run.id]
      publishQueue()
      setImmediate(() => void drain())
    }
    return { success: true, run }
  }

  const activeRun = ({ threadId }: { threadId: Id }): Run | null => active.get(threadId) ?? null

  const continueAfterApproval: RuntimeEngine["continueAfterApproval"] = (ctx) => {
    const run = ctx.runId ? active.get(ctx.threadId) : null
    if (
      !run ||
      run.id !== ctx.runId ||
      run.botId !== ctx.botId ||
      ctx.signal.aborted ||
      getState(run.id).cancelRequested ||
      !isLive(run)
    )
      return false
    getState(run.id).continueAfterApproval = true
    return true
  }

  const cancel = (id: Id): Result<{ run: Run }, "NOT_FOUND"> => {
    const run = persistence.getRun(id)
    if (!run) return { success: false, errorCode: "NOT_FOUND", error: "Run not found" }
    if (!["queued", "starting", "running"].includes(run.status)) return { success: true, run }
    if (run.status === "queued" || (run.status === "starting" && run.providerStartedAt == null)) {
      controllers.get(id)?.abort()
      const store = kernel.services.use("store.api")
      const thread = store?.getThread({ threadId: run.threadId })
      if (store && thread) {
        void finalizeFailure({
          run,
          state: getState(id),
          store,
          thread,
          errorClass: "canceled",
          errorMessage: "Turno cancelado antes de iniciar",
        })
        return { success: true, run }
      }
      updateRun(run, {
        status: "canceled",
        errorClass: "canceled",
        errorMessage: "Canceled before start",
        finishedAt: Date.now(),
      })
      finishRoutineRun({ run, state: getState(id), status: "canceled", summary: "Turno cancelado" })
      return { success: true, run }
    }
    const state = getState(id)
    state.cancelRequested = true
    controllers.get(id)?.abort()
    finishParts({ run, state, reason: "cancelled_by_user" })
    state.parts.forEach((part, index) => {
      if (part.type === "text" || part.type === "reasoning") state.dirtyParts.add(index)
    })
    const store = kernel.services.use("store.api")
    if (store) publishMessage({ store, state, run, status: "streaming" })
    approvalBridge.cancelRun(id)
    return { success: true, run }
  }

  const cancelBotTurns = async ({ botId }: { botId: Id }): Promise<void> => {
    const runs = [...persistence.listActiveRuns(), ...queued.map((id) => persistence.getRun(id))].filter(
      (run): run is Run => !!run && run.botId === botId && ["queued", "starting", "running"].includes(run.status),
    )
    await cancelRuns(runs.map((run) => run.id))
  }

  const cancelRuns = async (runIds: Id[]): Promise<void> => {
    runIds.forEach((runId) => {
      cancel(runId)
    })
    await Promise.all(runIds.map((runId) => executions.get(runId)))
  }

  const retry: RuntimeEngine["retry"] = (id) => {
    const previous = persistence.getRun(id)
    if (!previous?.requestMessageId) return { success: false, errorCode: "NOT_FOUND", error: "Run not found" }
    if (["queued", "starting", "running", "succeeded"].includes(previous.status))
      return { success: true, run: previous }
    // A retry is identified by the failed run, including after a lost HTTP acknowledgement.
    const attempts = persistence.listRuns(previous.threadId, { all: true })
    const previousIndex = attempts.findIndex((run) => run.id === previous.id)
    const existing = attempts
      .slice(0, previousIndex)
      .find((run) => run.requestMessageId === previous.requestMessageId && run.trigger === "retry")
    if (existing) return { success: true, run: existing }
    const parts =
      kernel.services
        .use("store.api")
        ?.activePath({
          threadId: previous.threadId,
          ...(previous.replyMessageId ? { leafId: previous.replyMessageId } : {}),
        })
        .filter((message) => message.runId === previous.id)
        .flatMap((message) => message.parts) ?? []
    if (hasRecordedActions(parts))
      return {
        success: false,
        errorCode: "CONFLICT",
        error: "A resposta foi interrompida. Algumas ações podem ter sido concluídas.",
      }
    return previous.routineRunId
      ? enqueue({
          threadId: previous.threadId,
          requestMessageId: previous.requestMessageId,
          trigger: "retry",
          routineRunId: previous.routineRunId,
        })
      : enqueue({ threadId: previous.threadId, requestMessageId: previous.requestMessageId, trigger: "retry" })
  }

  const answerApproval = async ({
    approvalId,
    decision,
    standing,
    message,
  }: {
    approvalId: Id
    decision: "approved" | "denied"
    standing?: boolean
    message?: string
  }): Promise<Result<object, "NOT_FOUND">> => {
    const resolution = decision === "approved" ? "allow" : message ? "answer" : "deny"
    const bridged = await approvalBridge.approve({
      approvalId,
      decision,
      ...(standing === undefined ? {} : { standing }),
      ...(message === undefined ? {} : { message }),
    })
    if (bridged.success) return bridged
    const pending = pendingApprovals.get(approvalId)
    if (!pending) return { success: false, errorCode: "NOT_FOUND", error: "Approval not found" }
    const currentRun = persistence.getRun(pending.runId)
    if (
      !currentRun ||
      !isLive(currentRun) ||
      controllers.get(pending.runId)?.signal.aborted ||
      getState(pending.runId).cancelRequested
    ) {
      pendingApprovals.delete(approvalId)
      return { success: false, errorCode: "NOT_FOUND", error: "A execução terminou." }
    }
    pendingApprovals.delete(approvalId)
    const result = await pending.provider.answerApproval({ approvalId: pending.providerApprovalId, decision })
    if (!result.success) return result
    notices.resolve({ requestId: approvalId, resolution })
    const state = getState(pending.runId)
    const approval = state.parts.find(
      (part): part is ApprovalPart => part.type === "approval" && part.approvalId === approvalId,
    )
    if (approval) {
      approval.decision = decision
      approval.resolvedAt = Date.now()
      state.dirtyParts.add(state.parts.indexOf(approval))
    }
    const run = persistence.getRun(pending.runId)
    const store = run ? kernel.services.use("store.api") : null
    if (run && store) publishMessage({ store, state, run, status: "streaming" })
    return { success: true }
  }

  const approvalBridge = createApprovalBridge({
    kernel,
    onCard: (ctx, part) => {
      const store = kernel.services.use("store.api")
      const run = ctx.runId ? persistence.getRun(ctx.runId) : null
      if (!store || !run || run.botId !== ctx.botId || run.threadId !== ctx.threadId) return false
      if (!["starting", "running"].includes(run.status)) return false
      const state = getState(run.id)
      const existing = state.parts.findIndex(
        (value) => value.type === "approval" && value.approvalId === part.approvalId,
      )
      if (existing >= 0) state.parts[existing] = part
      else state.parts.push(part)
      state.dirtyParts.add(existing >= 0 ? existing : state.parts.length - 1)
      const thread = store.getThread({ threadId: ctx.threadId })
      if (!thread) return false
      ensureReply({ run, state, store, parentId: run.requestMessageId ?? thread.activeLeafId ?? run.id })
      publishMessage({ store, state, run, status: "streaming" })
      return true
    },
  })

  const approvalPrompt: RuntimeEngine["approvalPrompt"] = (input) => {
    const bot = kernel.services.use("store.api")?.getBot({ botId: input.ctx.botId })
    const access = bot?.access
    const provider = bot?.provider
    return approvalBridge.present({
      ...input,
      scope: { source: provider === "opencode" ? "opencode" : "claude", tool: input.toolName },
      ...(provider === "opencode" ? { allowStanding: false } : {}),
      isCurrent: () => {
        const run = input.ctx.runId ? persistence.getRun(input.ctx.runId) : null
        const latest = kernel.services.use("store.api")?.getBot({ botId: input.ctx.botId })
        return (
          !!run &&
          run.botId === input.ctx.botId &&
          run.threadId === input.ctx.threadId &&
          ["starting", "running"].includes(run.status) &&
          !getState(run.id).cancelRequested &&
          !!latest &&
          latest.access === access &&
          latest.provider === provider
        )
      },
    })
  }

  const listRoutines = (botId?: Id): Array<Routine> => persistence.listRoutines(botId)
  const listRoutineRuns = (routineId: Id): Array<RoutineRun> => persistence.listRoutineRuns(routineId)

  // A group routine posts into one of the group's conversations; a bot routine only into the bot's own.
  const routineTargetError = (
    input: Pick<RoutineCreate, "botId" | "continuity" | "resultsThreadId" | "groupId">,
  ): string | null => {
    const store = kernel.services.use("store.api")
    const thread = input.resultsThreadId ? store?.getThread({ threadId: input.resultsThreadId }) : null
    if (!input.groupId) {
      if (input.resultsThreadId && (thread?.botId !== input.botId || thread.groupId))
        return "Results conversation must belong to this bot"
      return null
    }
    const group = createGroupStore(kernel).get(input.groupId)
    if (!group) return "Group not found"
    if (!group.memberIds.includes(input.botId)) return "The routine's bot must be a member of the group"
    if (input.continuity === "main-thread") return "A group routine posts into a group conversation"
    if (input.resultsThreadId && (thread?.groupId !== group.id || thread.groupThreadId))
      return "Results conversation must belong to this group"
    return null
  }

  const createRoutine = ({
    input,
    forceDisabled,
  }: {
    input: RoutineCreate
    forceDisabled: boolean
  }): Result<{ routine: Routine }, "BOT_NOT_FOUND" | "INVALID_ARGS"> => {
    const store = kernel.services.use("store.api")
    if (!store?.getBot({ botId: input.botId }))
      return { success: false, errorCode: "BOT_NOT_FOUND", error: "Bot not found" }
    const validation = routineError(input) ?? routineTargetError(input)
    if (validation) return { success: false, errorCode: "INVALID_ARGS", error: validation }
    const now = getNow()
    const routine: Routine = {
      id: kernel.newId(),
      botId: input.botId,
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      timezone: input.timezone,
      enabled: forceDisabled ? false : input.enabled,
      continuity: input.continuity,
      resultsThreadId: input.resultsThreadId,
      groupId: input.groupId,
      timeoutMinutes: input.timeoutMinutes,
      overlap: input.overlap,
      catchUpMinutes: input.catchUpMinutes,
      nextRunAt: null,
      source: "local",
      createdAt: now,
      updatedAt: now,
    }
    if (routine.enabled) {
      const parsed = parseCron(routine.cron)
      if (parsed.success)
        routine.nextRunAt = nextCronSlot({ cron: parsed.cron, timezone: routine.timezone, at: now + 1 })
    }
    persistence.saveRoutine(routine)
    kernel.publish({ type: "routine.updated", routine, lastRun: null })
    return { success: true, routine }
  }

  const updateRoutine = ({
    routineId,
    patch,
    fromTool,
    botId,
  }: RoutineUpdate): Result<{ routine: Routine }, "NOT_FOUND" | "NOT_OWNED" | "INVALID_ARGS"> => {
    const routine = persistence.getRoutine(routineId)
    if (!routine) return { success: false, errorCode: "NOT_FOUND", error: "Routine not found" }
    if (fromTool && botId !== routine.botId)
      return { success: false, errorCode: "NOT_OWNED", error: "This routine belongs to another bot" }
    if (fromTool && patch.enabled === true)
      return { success: false, errorCode: "INVALID_ARGS", error: "Agents cannot enable routines" }
    if (fromTool && patch.groupId !== undefined && patch.groupId !== routine.groupId)
      return { success: false, errorCode: "INVALID_ARGS", error: "Agents cannot change a routine's group" }
    // Agent edits need a new human activation; HTTP edits preserve omitted fields.
    const reviewedFields = [
      "prompt",
      "cron",
      "timezone",
      "continuity",
      "resultsThreadId",
      "groupId",
      "timeoutMinutes",
      "catchUpMinutes",
      "overlap",
    ] as const
    const needsReview = fromTool && reviewedFields.some((field) => field in patch && patch[field] !== routine[field])
    const updated = Object.assign({}, routine, patch, {
      id: routine.id,
      botId: routine.botId,
      enabled: needsReview ? false : (patch.enabled ?? routine.enabled),
      updatedAt: getNow(),
    })

    const validation = routineError(updated) ?? routineTargetError(updated)
    if (validation) return { success: false, errorCode: "INVALID_ARGS", error: validation }
    const next = Object.assign({}, updated, { nextRunAt: getRoutineNextRunAt(routine, updated, getNow()) })
    persistence.updateRoutine(next)
    kernel.publish({ type: "routine.updated", routine: next, lastRun: persistence.listRoutineRuns(next.id)[0] ?? null })
    return { success: true, routine: next }
  }

  const deleteRoutine = (routineId: Id): Result<object, "NOT_FOUND"> => {
    if (!persistence.getRoutine(routineId))
      return { success: false, errorCode: "NOT_FOUND", error: "Routine not found" }
    const pending = new Set(persistence.listRoutineRuns(routineId).map((run) => run.id))
    // Queued work has not started yet and must not fire after deletion. Starting
    // and running turns keep their existing controller and timeout and finish.
    for (const run of persistence.listQueuedRuns()) {
      if (run.routineRunId && pending.has(run.routineRunId)) cancel(run.id)
    }
    persistence.deleteRoutine(routineId)
    kernel.publish({ type: "routine.deleted", routineId })
    return { success: true }
  }

  const recordSkipped = ({
    routine,
    scheduledFor,
    triggerSource,
    wasOffline,
  }: {
    routine: Routine
    scheduledFor: number
    triggerSource: RoutineRun["triggerSource"]
    wasOffline: boolean
  }): void => {
    const reason = wasOffline
      ? "o touri não estava em execução no horário agendado."
      : "o atraso ultrapassou a janela de recuperação."
    const summary = `Rotina “${routine.name}” não executada: ${reason}`
    const inserted = persistence.insertRoutineRun({
      id: kernel.newId(),
      routineId: routine.id,
      scheduledFor,
      status: "skipped",
      threadId: null,
      runId: null,
      triggerSource,
      summary,
      startedAt: null,
      finishedAt: getNow(),
    })
    if (!inserted.success) return
    kernel.publish({ type: "routine.updated", routine, lastRun: inserted.routineRun })
    notices.deferred({
      botId: routine.botId,
      threadId: null,
      routineName: routine.name,
      reason: summary,
    })
  }

  const runRoutine = ({
    routineId,
    triggerSource,
    scheduledFor = Date.now(),
  }: {
    routineId: Id
    triggerSource: RoutineRun["triggerSource"]
    scheduledFor?: number
  }): Result<
    { routineRun: RoutineRun },
    "NOT_FOUND" | "INVALID_ARGS" | "THREAD_NOT_FOUND" | "BOT_PAUSED" | "DELEGATION_LIMIT" | "RUNTIME_DRAINING"
  > => {
    if (draining) return { success: false, errorCode: "RUNTIME_DRAINING", error: "O servidor está encerrando." }

    const routine = persistence.getRoutine(routineId)
    const store = kernel.services.use("store.api")
    if (!routine || !store) return { success: false, errorCode: "NOT_FOUND", error: "Routine not found" }
    if (triggerSource !== "manual" && (!routine.enabled || shuttingDown || !ownsRuntime()))
      return {
        success: false,
        errorCode: "INVALID_ARGS",
        error: `A rotina “${routine.name}” está pausada ou o runtime foi encerrado.`,
      }
    // Checked before a run row exists, so a removed member never leaves a slot stuck as scheduled.
    const targetError = routineTargetError(routine)
    if (targetError) return { success: false, errorCode: "INVALID_ARGS", error: targetError }
    const history = persistence.listRoutineRuns(routine.id)
    if (triggerSource === "manual") {
      const duplicate = history.find(
        (item) =>
          item.triggerSource === "manual" && (item.status === "running" || Date.now() - item.scheduledFor < 2000),
      )
      if (duplicate) return { success: true, routineRun: duplicate }
    }
    const previous = history.find((item) => item.status === "running")
    if (previous && routine.overlap === "skip") {
      const skipped: RoutineRun = {
        id: kernel.newId(),
        routineId: routine.id,
        scheduledFor,
        status: "skipped",
        threadId: null,
        runId: null,
        triggerSource,
        summary: `Rotina “${routine.name}” adiada: a execução anterior ainda está em andamento.`,
        startedAt: null,
        finishedAt: Date.now(),
      }
      const inserted = persistence.insertRoutineRun(skipped)
      if (inserted.success)
        notices.deferred({
          botId: routine.botId,
          threadId: null,
          routineName: routine.name,
          reason: `A rotina “${routine.name}” foi adiada porque a execução anterior ainda está em andamento.`,
        })
      return inserted.success
        ? inserted
        : { success: false, errorCode: "INVALID_ARGS", error: "Routine slot already exists" }
    }
    const scheduled: RoutineRun = {
      id: kernel.newId(),
      routineId: routine.id,
      scheduledFor,
      status: "scheduled",
      threadId: null,
      runId: null,
      triggerSource,
      summary: null,
      startedAt: null,
      finishedAt: null,
    }
    const inserted = persistence.insertRoutineRun(scheduled)
    if (!inserted.success) return { success: false, errorCode: "INVALID_ARGS", error: inserted.error }
    const bot = store.getBot({ botId: routine.botId })
    if (!bot) return { success: false, errorCode: "NOT_FOUND", error: "Bot not found" }
    const group = routine.groupId ? createGroupStore(kernel).get(routine.groupId) : null
    let threadId: Id | null = null
    if (routine.continuity === "main-thread") threadId = bot.mainThreadId
    else if (routine.continuity === "results-thread") threadId = routine.resultsThreadId
    if (!threadId && group) {
      const created = store.createThread({
        botId: group.memberIds[0] ?? bot.id,
        kind: "chat",
        title: formatRoutineTitle({ name: routine.name, at: scheduledFor, timezone: routine.timezone }),
        groupId: group.id,
      })
      if (!created.success)
        return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Unable to create routine thread" }
      threadId = created.thread.id
      if (routine.continuity === "results-thread")
        persistence.updateRoutine({ ...routine, resultsThreadId: threadId, updatedAt: Date.now() })
    }
    if (!threadId) {
      const threadArgs = {
        botId: bot.id,
        kind: "routine" as const,
        title: formatRoutineTitle({ name: routine.name, at: scheduledFor, timezone: routine.timezone }),
        routineRunId: scheduled.id,
      }
      const created = bot.mainThreadId
        ? store.createThread({ ...threadArgs, parentThreadId: bot.mainThreadId })
        : store.createThread(threadArgs)
      if (!created.success)
        return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Unable to create routine thread" }
      threadId = created.thread.id
      if (routine.continuity === "results-thread")
        persistence.updateRoutine({ ...routine, resultsThreadId: threadId, updatedAt: Date.now() })
    }
    const messageResult = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId,
        parentId: store.getThread({ threadId })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: routine.prompt,
        parts: [{ type: "text", text: routine.prompt }],
        sender: { name: "routine", id: routine.id },
        source: "local",
      },
    })
    if (!messageResult.success)
      return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Unable to insert routine prompt" }
    const request = {
      threadId,
      requestMessageId: messageResult.message.id,
      trigger: "routine" as const,
      routineRunId: scheduled.id,
    }
    // The group runtime routes the prompt to its members or coordinator, exactly like a user message.
    const groupRuntime = group ? kernel.services.use("groups.runtime") : null
    if (group && !groupRuntime)
      return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Group runtime unavailable" }
    const run = groupRuntime ? groupRuntime.enqueue(request) : enqueue(request)
    if (!run.success) {
      const failed: RoutineRun = {
        ...scheduled,
        status: "failed",
        threadId,
        summary: run.error,
        finishedAt: Date.now(),
      }
      persistence.updateRoutineRun(failed)
      kernel.publish({ type: "routine.updated", routine, lastRun: failed })
      return run
    }
    const running: RoutineRun = { ...scheduled, status: "running", threadId, runId: run.run.id, startedAt: Date.now() }
    persistence.updateRoutineRun(running)
    kernel.publish({ type: "routine.updated", routine, lastRun: running })
    return { success: true, routineRun: running }
  }

  const tick = async (now = getNow()): Promise<void> => {
    if (shuttingDown || draining || !ownsRuntime()) return
    const updateNextRun = ({ routineId, nextRunAt }: { routineId: Id; nextRunAt: number | null }): void => {
      const latest = persistence.getRoutine(routineId)
      if (latest) persistence.updateRoutine({ ...latest, nextRunAt, updatedAt: Date.now() })
    }
    for (const routine of persistence.listRoutines().filter((item) => item.enabled)) {
      if (kernel.services.use("store.api")?.getBot({ botId: routine.botId })?.machine === "cloud") continue
      const parsed = parseCron(routine.cron)
      if (!parsed.success || !validTimezone(routine.timezone)) continue
      let due = routine.nextRunAt
      if (due === null) {
        const previous = previousCronSlot({ cron: parsed.cron, timezone: routine.timezone, at: now })
        if (previous !== null && canRunRoutineSlot(routine, previous, now, runtimeStartedAt))
          void runRoutine({ routineId: routine.id, triggerSource: "catch-up", scheduledFor: previous })
        else if (previous !== null)
          recordSkipped({
            routine,
            scheduledFor: previous,
            triggerSource: "catch-up",
            wasOffline: previous < runtimeStartedAt,
          })
        due = nextCronSlot({ cron: parsed.cron, timezone: routine.timezone, at: now + 60_000 })
        updateNextRun({ routineId: routine.id, nextRunAt: due })
        continue
      }
      if (due <= now) {
        if (!canRunRoutineSlot(routine, due, now, runtimeStartedAt))
          recordSkipped({ routine, scheduledFor: due, triggerSource: "catch-up", wasOffline: due < runtimeStartedAt })
        else
          void runRoutine({
            routineId: routine.id,
            triggerSource: due < runtimeStartedAt || now - due > ROUTINE_TICK_GRACE_MS ? "catch-up" : "cron",
            scheduledFor: due,
          })
        const next = nextCronSlot({ cron: parsed.cron, timezone: routine.timezone, at: due + 60_000 })
        updateNextRun({ routineId: routine.id, nextRunAt: next })
      }
    }
  }

  const beginDrain = (): void => {
    draining = true
  }

  const canDrainRun = (runId: Id): boolean => continuations.link(runId) !== null || continuations.isGroupRun(runId)

  const waitForDrain = async (): Promise<void> => {
    await startupCleanup
    while (!shuttingDown && (executions.size > 0 || pendingContinuations.size > 0 || queued.some(canDrainRun))) {
      await drain()
      await Promise.all(executions.values())
      // Continuations can be scheduled after their provider execution finishes.
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    draining = true
    unsubscribeGroupTurns()
    for (const state of states.values()) {
      if (state.outputTimer) clearTimeout(state.outputTimer)
      state.outputTimer = null
    }
    for (const [id, pending] of pendingContinuations) {
      clearTimeout(pending.timer)
      pendingContinuations.delete(id)
      // Save the next run before stopping so a backoff or approval cannot disappear.
      if (!canStartContinuation(pending.run, pending.plan) || !startContinuation(pending))
        abandonContinuation({ run: pending.run, status: "failed" })
    }
    shuttingDown = true
    for (const [id, controller] of controllers) {
      const state = getState(id)
      state.completionError ??= { errorClass: "app_restart", errorMessage: "touri restarted" }
      controller.abort()
    }
    approvalBridge.dispose()
    shutdownPromise = (async () => {
      await startupCleanup
      await Promise.all(Object.values(adapters).map((adapter) => adapter.shutdown()))
      await Promise.all(executions.values())
    })()
    return shutdownPromise
  }

  // Both scans run `ps` asynchronously (#121); the record list is read before the first await.
  const startupCleanup = Promise.all([reapProviderProcesses(kernel), reapOrphanShims(kernel.paths.runDir)])
    .then(() => undefined)
    .catch((error) =>
      kernel.log({
        level: "error",
        module: "runtime",
        msg: "Falha ao encerrar processos órfãos",
        data: { error: error instanceof Error ? error.message : String(error) },
      }),
    )
  const recovered = new Set<Id>()
  for (const run of persistence.listActiveRuns()) {
    recovered.add(run.id)
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId: run.threadId })
    if (store && thread) {
      const state = getState(run.id)
      const reply = run.replyMessageId
        ? store
            .activePath({ threadId: run.threadId, leafId: run.replyMessageId })
            .find((message) => message.id === run.replyMessageId)
        : null
      if (reply) {
        state.replyMessageId = reply.id
        state.text = reply.text
        state.pendingText = []
        state.pendingPartText.clear()
        state.parts = structuredClone(reply.parts)
      }
      state.turnStarted = run.externalTurnId !== null
      const plan = planContinuation({
        run,
        reason: "app_restart",
        lastActivityAt: Math.max(run.startedAt ?? run.queuedAt, reply?.updatedAt ?? 0),
      })
      finalizeFailure({
        run,
        state,
        store,
        thread,
        errorClass: "app_restart",
        errorMessage: "touri restarted",
        continuing: plan !== null,
      })
      if (plan && !startContinuation({ run, plan })) abandonContinuation({ run, status: "canceled" })
      continue
    }
    const finishedAt = Date.now()
    updateRun(run, {
      status: "interrupted",
      errorClass: "app_restart",
      errorMessage: "touri restarted",
      finishedAt,
    })
    if (run.routineRunId) {
      const routineRun = persistence.getRoutineRun(run.routineRunId)
      if (routineRun && routineRun.status === "running")
        persistence.updateRoutineRun({
          ...routineRun,
          status: "canceled",
          summary: "Interrupted because touri restarted",
          finishedAt,
        })
    }
  }

  for (const runId of continuations.recentlyInterrupted(Date.now() - CONTINUATION_WINDOW_MS)) {
    const run = persistence.getRun(runId)
    if (!run || recovered.has(run.id) || persistence.listRuns(run.threadId)[0]?.id !== run.id) continue
    const plan = planContinuation({ run, reason: "app_restart", lastActivityAt: run.finishedAt ?? run.queuedAt })
    if (plan) startContinuation({ run, plan })
  }

  goals.getActive().forEach((goal) => {
    const run = goal.runId ? persistence.getRun(goal.runId) : null
    if (run && ["queued", "starting", "running"].includes(run.status)) return
    if (!goals.prepareContinuation(goal)) return
    const isLatest = run && persistence.listRuns(goal.threadId)[0]?.id === run.id
    const plan = isLatest
      ? planContinuation({ run, reason: "app_restart", lastActivityAt: run.finishedAt ?? run.queuedAt })
      : null
    if (run && plan && startContinuation({ run, plan })) return

    const current = goals.getGoal(goal.threadId)
    if (current?.status === "active") goals.saveGoal({ ...current, status: "paused" })
  })

  const recoveryStore = kernel.services.use("store.api")
  // Recovery repairs persisted history once. Terminal transitions already settle
  // their own tools; repeating recovery per turn rescans every previous result.
  if (recoveryStore) tools.reconcile(recoveryStore)
  queueMicrotask(() => void drain())

  return {
    ready: startupCleanup,
    goals,
    enqueue,
    activeRun,
    continueAfterApproval,
    getRunSnapshot,
    getWorkRuns,
    settingsChanged: () => {
      void drain()
    },
    listRuns: persistence.listRuns,
    cancel,
    cancelBotTurns,
    cancelRuns,
    retry,
    answerApproval,
    approvalBridge,
    approvalPrompt,
    listRoutines,
    listRoutineRuns,
    createRoutine,
    updateRoutine,
    deleteRoutine,
    runRoutine,
    tick,
    beginDrain,
    waitForDrain,
    shutdown,
  }
}

const getRoutineNextRunAt = (previous: Routine, next: Routine, now: number): number | null => {
  if (!next.enabled) return null
  if (previous.enabled && next.cron === previous.cron && next.timezone === previous.timezone) return next.nextRunAt

  const parsed = parseCron(next.cron)
  if (!parsed.success) return null

  return nextCronSlot({ cron: parsed.cron, timezone: next.timezone, at: now + 1 })
}

const canRunRoutineSlot = (routine: Routine, scheduledFor: number, now: number, runtimeStartedAt: number): boolean => {
  if (routine.catchUpMinutes === 0 && scheduledFor < runtimeStartedAt) return false

  const catchUpWindowMs = routine.catchUpMinutes * 60_000 + ROUTINE_TICK_GRACE_MS
  return now - scheduledFor <= catchUpWindowMs
}
