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
import { refineErrorClass, safeRunFailure } from "@touri/contracts/run-failure"
import { createApprovalBridge } from "../approvals/bridge"
import { approvalOutcome } from "../approvals/outcome"
import { delegatedBot } from "../groups/security"
import { buildChildEnv } from "../kernel"
import { resolveMcpSocketPath } from "../kernel/paths"
import { providerProfileEnv } from "../kernel/provider-profiles"
import { redactStructured } from "../kernel/redact"
import { attachedServers, resolveAttachedMcp } from "../mcp/attached"
import { reapOrphanShims } from "../mcp/shim-registry"
import { prepareLocalProviderLogin } from "../vm/local-provider-login"
import { ProviderLoginError } from "../vm/provider-login"
import { redactVmEvents } from "../vm/redact-events"
import { MachineServiceError } from "../vm/service-error"
import { VmStageError, vmStage } from "../vm/stage"
import { createClaudeAdapter } from "./claude/adapter"
import { createCodexAdapter } from "./codex/adapter"
import { COMMAND_OUTPUT_INTERVAL_MS, commandOutputTail } from "./command-output"
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
import { bounded, randomHexToken, writePrivateFile } from "./utils"
import { startVmTurn } from "./vm-turn"
import { createWorkState, type WorkState } from "./work-state"

type RunState = {
  text: string
  textItemIds: Set<string>
  parts: Array<MessagePart>
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
  lastOutputPublishedAt: number
}

type ContinuationPlan = { reason: ContinuationReason; originalRunId: Id }

type PendingApproval = { runId: Id; provider: ProviderAdapter; providerApprovalId: Id }

type RoutineCreate = {
  botId: Id
  name: string
  prompt: string
  cron: string
  timezone: string
  enabled: boolean
  continuity: RoutineContinuity
  resultsThreadId: Id | null
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
  enqueue: (args: {
    threadId: Id
    requestMessageId: Id
    trigger: RunTrigger
    routineRunId?: Id
    delegated?: boolean
  }) => Result<{ run: Run }, "THREAD_NOT_FOUND" | "BOT_PAUSED">
  listRuns: (threadId: Id, options?: { all?: boolean }) => Array<Run>
  activeRun: (args: { threadId: Id }) => Run | null
  continueAfterApproval: ServiceMap["runtime.continueAfterApproval"]
  cancel: (id: Id) => Result<{ run: Run }, "NOT_FOUND">
  cancelBotTurns: (args: { botId: Id }) => Promise<void>
  retry: (id: Id) => Result<{ run: Run }, "NOT_FOUND" | "THREAD_NOT_FOUND" | "BOT_PAUSED">
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
  runRoutine: (args: {
    routineId: Id
    triggerSource: RoutineRun["triggerSource"]
    scheduledFor?: number
  }) => Result<{ routineRun: RoutineRun }, "NOT_FOUND" | "INVALID_ARGS" | "THREAD_NOT_FOUND" | "BOT_PAUSED">
  tick: (now?: number) => Promise<void>
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
}): RuntimeEngine => {
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
  const queued: Array<Id> = persistence.listQueuedRuns().map((run) => run.id)
  let shuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  const tools = createToolResolutions(kernel)
  const active = new Map<Id, Run>()
  const controllers = new Map<Id, AbortController>()
  const executions = new Map<Id, Promise<void>>()
  const providers = new Map<Id, ProviderAdapter>()
  const states = new Map<Id, RunState>()
  const pendingApprovals = new Map<Id, PendingApproval>()
  const codexOptions = {
    kernel,
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
  const maxConcurrentRuns = Math.max(
    1,
    configuredMaxConcurrentRuns ?? Number(process.env.TOURI_MAX_CONCURRENT_RUNS ?? 3),
  )
  const routineTimeout = routineTimeoutMs ?? ((routine: Routine): number => routine.timeoutMinutes * 60_000)

  const notices = createRuntimeNotices({ kernel })
  const work: WorkState = createWorkState({ database: kernel.db as Database })
  const continuations = createRunContinuations({ database: kernel.db })
  const pendingContinuations = new Map<Id, { timer: ReturnType<typeof setTimeout>; run: Run }>()

  const publishRun = (run: Run): void => kernel.publish({ type: "run.updated", run: cloneRun(run) })

  const updateRun = (run: Run, patch: Partial<Run>): Run => {
    const next = { ...run, ...patch }
    if (!persistence.saveRun(next)) {
      const stored = persistence.getRun(run.id)
      if (stored) Object.assign(run, stored)
      return run
    }
    Object.assign(run, next)
    publishRun(run)
    return run
  }

  const isLive = (run: Run): boolean => {
    if (!ownsRuntime()) return false
    const stored = persistence.getRun(run.id)
    return stored !== null && ["queued", "starting", "running"].includes(stored.status)
  }

  const finishLiveRun = (run: Run, finish: () => void): void => {
    const write = (): void => {
      if (isLive(run)) finish()
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
      textItemIds: new Set(),
      parts: [],
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
    const message: Omit<Message, "createdAt" | "updatedAt"> = {
      id: kernel.newId(),
      threadId: run.threadId,
      parentId,
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
    run.replyMessageId = result.message.id
    persistence.saveRun(run)
    kernel.publish({ type: "message.created", message: result.message })
  }

  const publishMessage = ({
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
    state.lastOutputPublishedAt = Date.now()
    state.parts = state.cancelRequested
      ? tools.finish(run, state.parts, "cancelled_by_user")
      : state.parts.map((part) => ("callId" in part ? tools.record(run, part) : part))
    if (!state.replyMessageId) return
    const updated = store.updateMessage({
      threadId: run.threadId,
      messageId: state.replyMessageId,
      patch: { status, parts: state.parts, text: state.text, runId: run.id },
    })
    if (updated.success) kernel.publish({ type: "message.updated", message: updated.message })
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
  }): void => {
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
    if (result.success) kernel.publish({ type: "message.created", message: result.message })
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
        TOURI_MCP_SOCK: resolveMcpSocketPath(kernel.paths),
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
    if (!isLive(run)) {
      controllers.get(run.id)?.abort()
      return
    }
    if (event.type === "session") {
      state.externalSessionId = event.externalSessionId
      state.rolloutPath = event.rolloutPath
      if (state.fingerprint)
        continuations.saveResumePoint({
          runId: run.id,
          point: {
            externalSessionId: event.externalSessionId,
            rolloutPath: event.rolloutPath,
            fingerprint: state.fingerprint,
          },
        })
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
        const request =
          run.requestMessageId && thread
            ? store.activePath({ threadId: run.threadId }).find((message) => message.id === run.requestMessageId)
            : null
        if (request) ensureReply({ run, state, store, parentId: request.id })
      }
      // Provider items are separate Markdown documents; chunks within an item are not.
      // Persist the separator as part of the delta so replay and crash recovery agree.
      const separator = state.text && !state.textItemIds.has(event.itemId) ? "\n\n" : ""
      state.textItemIds.add(event.itemId)
      const delta = separator + event.delta
      const prose = [...state.parts].reverse().find((part) => part.type === "text" || part.type === "reasoning")
      const existing = prose?.type === "text" ? prose : undefined
      if (existing) existing.text += delta
      else state.parts.push({ type: "text", text: delta })
      state.text += delta
      if (state.replyMessageId)
        store.appendDelta({
          threadId: run.threadId,
          messageId: state.replyMessageId,
          partIndex: existing ? state.parts.indexOf(existing) : state.parts.length - 1,
          delta,
          ...(state.generation === null ? {} : { generation: state.generation }),
        })
      return
    }
    if (event.type === "reasoning_delta" || event.type === "reasoning_progress") {
      if (event.type === "reasoning_delta" && !event.delta) return
      const last = state.parts.at(-1)
      const previous = last?.type === "reasoning" ? last : { type: "reasoning" as const, text: "" }
      const part =
        event.type === "reasoning_progress"
          ? { ...previous, estimatedTokens: event.estimatedTokens }
          : { ...previous, text: previous.text + event.delta }
      state.parts = last?.type === "reasoning" ? [...state.parts.slice(0, -1), part] : [...state.parts, part]
      if (last?.type === "reasoning" && event.type === "reasoning_delta") {
        if (state.replyMessageId)
          store.appendDelta({
            threadId: run.threadId,
            messageId: state.replyMessageId,
            partIndex: state.parts.length - 1,
            delta: event.delta,
            ...(state.generation === null ? {} : { generation: state.generation }),
          })
      } else {
        if (state.replyMessageId) publishMessage({ store, state, run, status: "streaming" })
        else {
          const request = store
            .activePath({ threadId: run.threadId })
            .find((message) => message.id === run.requestMessageId)
          if (request) ensureReply({ run, state, store, parentId: request.id })
        }
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
      const index =
        "callId" in part
          ? state.parts.findIndex(
              (candidate) => "callId" in candidate && candidate.callId === part.callId && candidate.type === part.type,
            )
          : -1
      const previous = state.parts[index]
      if (previous?.type === "tool_call" && part.type === "tool_call") {
        state.parts[index] = {
          ...part,
          inputJson: part.inputJson === "{}" ? previous.inputJson : part.inputJson,
          outputJson: part.outputJson ?? previous.outputJson,
          ok: part.ok ?? previous.ok,
          ...(previous.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        }
      } else if (previous?.type === "command" && part.type === "command") {
        state.parts[index] = {
          ...part,
          command: part.command || previous.command,
          cwd: part.cwd || previous.cwd,
          outputTail: part.outputTail || previous.outputTail,
          exitCode: part.exitCode ?? previous.exitCode,
          ...(previous.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
        }
      } else if (index >= 0) state.parts[index] = part
      else {
        state.parts.push(part)
        if (part.type === "tool_call") state.usage.toolCalls += 1
      }
      const thread = store.getThread({ threadId: run.threadId })
      const request =
        run.requestMessageId && thread
          ? store.activePath({ threadId: run.threadId }).find((message) => message.id === run.requestMessageId)
          : null
      if (request) ensureReply({ run, state, store, parentId: request.id })
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
      publishMessage({ store, state, run, status: "streaming" })
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
      notices.approval({
        botId: run.botId,
        threadId: run.threadId,
        requestId: approvalId,
        request: event.part.request,
        detail: event.part.detail,
        scope: event.part.scope,
      })
      const thread = store.getThread({ threadId: run.threadId })
      const request =
        run.requestMessageId && thread
          ? store.activePath({ threadId: run.threadId }).find((message) => message.id === run.requestMessageId)
          : null
      if (request) ensureReply({ run, state, store, parentId: request.id })
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

  const activePathMessage = ({ store, run }: { store: StoreApi; run: Run }): Message | null =>
    store.activePath({ threadId: run.threadId }).find((message) => message.id === run.requestMessageId) ?? null

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

  const execute = async (run: Run): Promise<void> => {
    if (!isLive(run)) {
      active.delete(run.threadId)
      return
    }
    const recoveryStore = kernel.services.use("store.api")
    if (recoveryStore) tools.reconcile(recoveryStore, run.threadId)
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
    const thread = store.getThread({ threadId: run.threadId })
    const ownBot = thread ? store.getBot({ botId: thread.botId }) : null
    const bot = thread && ownBot ? delegatedBot(kernel, thread.id, ownBot) : null
    if (!thread || !bot) {
      updateRun(run, {
        status: "failed",
        errorClass: "unknown",
        errorMessage: "Thread or bot not found",
        finishedAt: Date.now(),
      })
      return
    }
    const state = getState(run.id)
    const request = activePathMessage({ store, run })
    const resumedFrom = request?.role === "system" ? continuationReasonOf(request.text) : null
    const link = continuations.link(run.id)
    const originalRun = link ? persistence.getRun(link.originalRunId) : null
    const originalRequest =
      resumedFrom === "permission_granted" && originalRun ? activePathMessage({ store, run: originalRun }) : null
    const requestText = resumedFrom
      ? [continuationPrompt(resumedFrom), originalRequest ? `Original request:\n${originalRequest.text}` : null]
          .filter(Boolean)
          .join("\n\n")
      : (request?.text ?? "")
    const carryover = thread.carryoverNote
    if (carryover) store.updateThread({ threadId: thread.id, patch: { carryoverNote: null } })
    const toolSummary = tools.summary(store, thread.id, request?.id)
    const inputText = [carryover, toolSummary, requestText].filter(Boolean).join("\n\n")
    const input: Array<TextPart | Extract<MessagePart, { type: "image" }>> = request
      ? [
          { type: "text", text: inputText },
          ...(originalRequest ?? request).parts.filter(
            (part): part is Extract<MessagePart, { type: "image" }> => part.type === "image",
          ),
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
    const previousSession = persistence.getActiveSession({ threadId: thread.id, provider: bot.provider })
    let session = previousSession
    let handoffPacket: string | null = null
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
      handoffPacket = bounded({
        value: [
          "Continue from the partial transcript. Check the recorded work and current state before repeating actions; finish the user's original request.",
          buildHandoffPacket({ kernel, thread, reason: "app restarted during the previous turn" }),
        ].join("\n"),
        max: 32_000,
      })
    }
    if (session && session.fingerprint !== mcpFingerprint.hash && session.fingerprint !== "imported") {
      persistence.markSession({ id: session.id, state: "replaced" })
      handoffPacket = buildHandoffPacket({ kernel, thread, reason: "session fingerprint changed" })
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
    const baseEnvironment = bot.machine === "vm" ? {} : environment?.PATH ? environment : await kernel.shellEnv()
    const env = buildChildEnv({
      base: baseEnvironment,
      overrides: {
        ...environment,
        ...providerProfileEnv({ appData: kernel.paths.appData, bot }),
        TOURI_RUN_DIR: kernel.paths.runDir,
        TOURI_APP_DATA: kernel.paths.appData,
        ...(bot.machine === "vm" ? {} : { TOURI_MCP_SOCK: resolveMcpSocketPath(kernel.paths) }),
        ...(projectDataDir ? { TOURI_PROJECT_DATA_DIR: projectDataDir } : {}),
      },
    })
    if (shuttingDown || !isLive(run)) {
      active.delete(run.threadId)
      if (!shuttingDown) void drain()
      return
    }
    updateRun(run, { status: "starting", startedAt: Date.now() })
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
            mcpServers: await resolveAttachedMcp(kernel, prepared?.bot ?? bot),
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
        const emit = (event: ProviderEvent) => handleEvent({ run, event, store, state })
        const safeEvents = redactVmEvents({ secrets: [], redact: kernel.redact, emit })
        flushEvents = safeEvents.flush
        // VM preparation registers its credentials with the same live registry.
        // Keep a single stream boundary for native and guest turns, before storage.
        const onEvent = safeEvents
        const startTurn: ProviderAdapter["startTurn"] = prepared
          ? (args) => startVmTurn({ kernel, provider, args })
          : provider.startTurn
        const invoke = (): ReturnType<typeof startTurn> =>
          startTurn({
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
        const invokeWithRetry = (): ReturnType<typeof startTurn> =>
          retryTransient({
            run: invoke,
            failureOf: (outcome) => (outcome.success ? null : outcome.error),
            canRetry: () => !state.turnStarted,
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
          handoffPacket = buildHandoffPacket({ kernel, thread, reason: "native session could not be resumed" })
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
        flushEvents?.()
        await prepared?.release()
        releaseLogin?.()
        if (deadline) clearTimeout(deadline)
      }
    })()
    approvalBridge.cancelRun(run.id)
    for (const [approvalId, approval] of pendingApprovals) {
      if (approval.runId !== run.id) continue
      pendingApprovals.delete(approvalId)
      notices.resolve({ requestId: approvalId, resolution: "expired" })
      const part = state.parts.find((part) => part.type === "approval" && part.approvalId === approvalId)
      if (part?.type === "approval") {
        part.decision = "expired"
        part.resolvedAt = Date.now()
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
      const sessionRow = session ?? {
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
          state.parts = tools.finish(run, state.parts, "unknown")
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
            finishRoutineRun({ run, state, status: "succeeded" })
            notices.done({ botId: run.botId, threadId: run.threadId, summary: state.text })
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
      state.parts = tools.finish(
        run,
        state.parts,
        errorClass === "canceled"
          ? "cancelled_by_user"
          : errorClass === "app_restart"
            ? "interrupted_by_restart"
            : "failed",
      )
      state.parts = state.parts.map((part) => {
        if (part.type !== "approval" || part.decision !== "pending") return part
        pendingApprovals.delete(part.approvalId)
        notices.resolve({ requestId: part.approvalId, resolution: "deny" })
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
      state.parts.push({
        type: "notice",
        level: errorClass === "canceled" ? "info" : "error",
        code: noticeCode,
        ...(noticeCode === "run_failed" ? { failure } : {}),
        text: errorClass === "canceled" ? "Cancelado por você" : `${errorClass}: ${friendlyMessage}`,
      })
      publishMessage({ store, state, run, status: statusForError(errorClass) === "canceled" ? "canceled" : "failed" })
      const carryover = state.turnStarted
        ? `[touri: your previous turn ended with ${errorClass}. Partial output: "${bounded({ value: state.text, max: 1_500 })}"]`
        : `[touri: your previous turn did not run (${errorClass}: ${safeError}). The user's message was: "${bounded({ value: activePathMessage({ store, run })?.text ?? "", max: 1_500 })}"]`
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
    kernel.publish({ type: "message.created", message: marker.message })
    const next = enqueue({
      threadId: thread.id,
      requestMessageId: marker.message.id,
      trigger: run.routineRunId ? "routine" : "retry",
      ...(run.routineRunId ? { routineRunId: run.routineRunId } : {}),
    })
    if (!next.success) return false
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
  const abandonContinuation = ({ run, status }: { run: Run; status: RoutineRun["status"] }): void =>
    finishRoutineRun({ run, state: getState(run.id), status, summary: getState(run.id).text || "Turno interrompido" })

  const scheduleContinuation = ({ run, plan }: { run: Run; plan: ContinuationPlan }): void => {
    const timer = setTimeout(
      () => {
        pendingContinuations.delete(run.id)
        // A newer turn on the thread (the user wrote meanwhile) supersedes the continuation.
        const superseded = persistence.listRuns(run.threadId)[0]?.id !== run.id
        const ready =
          !shuttingDown && ownsRuntime() && (plan.reason === "permission_granted" || resumeEnabled()) && !superseded
        if (!ready || !startContinuation({ run, plan })) abandonContinuation({ run, status: "failed" })
      },
      plan.reason === "permission_granted" ? 0 : resumeBackoffMs,
    )
    pendingContinuations.set(run.id, { timer, run })
  }

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

  const drain = async (): Promise<void> => {
    while (!shuttingDown && ownsRuntime() && active.size < maxConcurrentRuns) {
      const nextIndex = queued.findIndex((runId) => {
        const run = persistence.getRun(runId)
        return run !== null && !active.has(run.threadId)
      })
      if (nextIndex < 0) return
      const [runId] = queued.splice(nextIndex, 1)
      if (!runId) return
      const run = persistence.getRun(runId)
      if (run?.status !== "queued") continue
      active.set(run.threadId, run)
      const execution = execute(run)
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
  }: {
    threadId: Id
    requestMessageId: Id
    trigger: RunTrigger
    routineRunId?: Id
    delegated?: boolean
  }): Result<{ run: Run }, "THREAD_NOT_FOUND" | "BOT_PAUSED"> => {
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId })
    const bot = thread ? store?.getBot({ botId: thread.botId }) : null
    if (!thread || !bot) return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Thread not found" }
    if (bot.paused || bot.machine === "cloud")
      return {
        success: false,
        errorCode: "BOT_PAUSED",
        error: bot.machine === "cloud" ? "Este bot usa o runtime remoto." : "Bot is paused",
      }
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
    publishRun(run)
    if (delegated) {
      // A synchronous peer request cannot wait behind its caller's occupied slot.
      // Only group runtime uses this path; depth/call/cycle limits bound extra work.
      queueMicrotask(() => {
        if (active.has(threadId)) {
          cancel(run.id)
          return
        }
        active.set(threadId, run)
        const execution = execute(run)
        executions.set(run.id, execution)
        void execution.finally(() => executions.delete(run.id)).catch(() => {})
      })
    } else {
      queued.push(run.id)
      queueMicrotask(() => void drain())
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
    if (run.status === "queued") {
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
    state.parts = tools.finish(run, state.parts, "cancelled_by_user")
    const store = kernel.services.use("store.api")
    if (store) publishMessage({ store, state, run, status: "streaming" })
    approvalBridge.cancelRun(id)
    return { success: true, run }
  }

  const cancelBotTurns = async ({ botId }: { botId: Id }): Promise<void> => {
    const runs = [...persistence.listActiveRuns(), ...queued.map((id) => persistence.getRun(id))].filter(
      (run): run is Run => !!run && run.botId === botId && ["queued", "starting", "running"].includes(run.status),
    )
    for (const run of runs) cancel(run.id)
    await Promise.all(runs.map((run) => executions.get(run.id)))
  }

  const retry = (id: Id): Result<{ run: Run }, "NOT_FOUND" | "THREAD_NOT_FOUND" | "BOT_PAUSED"> => {
    const previous = persistence.getRun(id)
    if (!previous?.requestMessageId) return { success: false, errorCode: "NOT_FOUND", error: "Run not found" }
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
    const validation = routineError(input)
    if (validation) return { success: false, errorCode: "INVALID_ARGS", error: validation }
    if (input.resultsThreadId && store.getThread({ threadId: input.resultsThreadId })?.botId !== input.botId)
      return { success: false, errorCode: "INVALID_ARGS", error: "Results conversation must belong to this bot" }
    const now = Date.now()
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
    const next = { ...routine, ...patch, id: routine.id, botId: routine.botId, updatedAt: Date.now() }
    // A changed task or destination needs a new explicit human activation.
    const reviewedFields = [
      "prompt",
      "cron",
      "timezone",
      "continuity",
      "resultsThreadId",
      "timeoutMinutes",
      "catchUpMinutes",
      "overlap",
    ] as const
    if (patch.enabled !== true && reviewedFields.some((field) => next[field] !== routine[field])) next.enabled = false

    const validation = routineError({
      botId: next.botId,
      name: next.name,
      prompt: next.prompt,
      cron: next.cron,
      timezone: next.timezone,
      enabled: next.enabled,
      continuity: next.continuity,
      resultsThreadId: next.resultsThreadId,
      timeoutMinutes: next.timeoutMinutes,
      overlap: next.overlap,
      catchUpMinutes: next.catchUpMinutes,
    })
    if (validation) return { success: false, errorCode: "INVALID_ARGS", error: validation }
    if (
      next.resultsThreadId &&
      kernel.services.use("store.api")?.getThread({ threadId: next.resultsThreadId })?.botId !== next.botId
    )
      return { success: false, errorCode: "INVALID_ARGS", error: "Results conversation must belong to this bot" }
    if (!next.enabled) next.nextRunAt = null
    else if (!routine.enabled || next.cron !== routine.cron || next.timezone !== routine.timezone) {
      const parsed = parseCron(next.cron)
      if (parsed.success)
        next.nextRunAt = nextCronSlot({ cron: parsed.cron, timezone: next.timezone, at: Date.now() + 1 })
    }
    persistence.updateRoutine(next)
    kernel.publish({ type: "routine.updated", routine: next, lastRun: persistence.listRoutineRuns(next.id)[0] ?? null })
    return { success: true, routine: next }
  }

  const recordSkipped = ({
    routine,
    scheduledFor,
    triggerSource,
  }: {
    routine: Routine
    scheduledFor: number
    triggerSource: RoutineRun["triggerSource"]
  }): void => {
    const inserted = persistence.insertRoutineRun({
      id: kernel.newId(),
      routineId: routine.id,
      scheduledFor,
      status: "skipped",
      threadId: null,
      runId: null,
      triggerSource,
      summary: `Rotina “${routine.name}” adiada: o touri estava fechado no horário agendado.`,
      startedAt: null,
      finishedAt: Date.now(),
    })
    if (!inserted.success) return
    kernel.publish({ type: "routine.updated", routine, lastRun: inserted.routineRun })
    notices.deferred({
      botId: routine.botId,
      threadId: null,
      routineName: routine.name,
      reason: `A rotina “${routine.name}” não foi executada porque o touri estava fechado no horário agendado.`,
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
  }): Result<{ routineRun: RoutineRun }, "NOT_FOUND" | "INVALID_ARGS" | "THREAD_NOT_FOUND" | "BOT_PAUSED"> => {
    const routine = persistence.getRoutine(routineId)
    const store = kernel.services.use("store.api")
    if (!routine || !store) return { success: false, errorCode: "NOT_FOUND", error: "Routine not found" }
    if (triggerSource !== "manual" && (!routine.enabled || shuttingDown || !ownsRuntime()))
      return {
        success: false,
        errorCode: "INVALID_ARGS",
        error: `A rotina “${routine.name}” está pausada ou o runtime foi encerrado.`,
      }
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
    let threadId: Id | null = null
    if (routine.continuity === "main-thread") threadId = bot.mainThreadId
    else if (routine.continuity === "results-thread") threadId = routine.resultsThreadId
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
    const run = enqueue({
      threadId,
      requestMessageId: messageResult.message.id,
      trigger: "routine",
      routineRunId: scheduled.id,
    })
    if (!run.success) return run
    const running: RoutineRun = { ...scheduled, status: "running", threadId, runId: run.run.id, startedAt: Date.now() }
    persistence.updateRoutineRun(running)
    kernel.publish({ type: "routine.updated", routine, lastRun: running })
    return { success: true, routineRun: running }
  }

  const tick = async (now = Date.now()): Promise<void> => {
    if (shuttingDown || !ownsRuntime()) return
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
        if (previous !== null && now - previous <= routine.catchUpMinutes * 60_000)
          void runRoutine({ routineId: routine.id, triggerSource: "catch-up", scheduledFor: previous })
        else if (previous !== null) recordSkipped({ routine, scheduledFor: previous, triggerSource: "catch-up" })
        due = nextCronSlot({ cron: parsed.cron, timezone: routine.timezone, at: now + 60_000 })
        updateNextRun({ routineId: routine.id, nextRunAt: due })
        continue
      }
      if (due <= now) {
        if (now - due > routine.catchUpMinutes * 60_000)
          recordSkipped({ routine, scheduledFor: due, triggerSource: "catch-up" })
        else
          void runRoutine({
            routineId: routine.id,
            triggerSource: now - due >= 60_000 ? "catch-up" : "cron",
            scheduledFor: due,
          })
        const next = nextCronSlot({ cron: parsed.cron, timezone: routine.timezone, at: due + 60_000 })
        updateNextRun({ routineId: routine.id, nextRunAt: next })
      }
    }
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    for (const state of states.values()) {
      if (state.outputTimer) clearTimeout(state.outputTimer)
      state.outputTimer = null
    }
    for (const [id, pending] of pendingContinuations) {
      clearTimeout(pending.timer)
      pendingContinuations.delete(id)
      abandonContinuation({ run: pending.run, status: "failed" })
    }
    for (const [id, controller] of controllers) {
      const state = getState(id)
      state.completionError ??= { errorClass: "app_restart", errorMessage: "touri restarted" }
      controller.abort()
    }
    approvalBridge.dispose()
    shutdownPromise = (async () => {
      await Promise.all(Object.values(adapters).map((adapter) => adapter.shutdown()))
      await Promise.all(executions.values())
    })()
    return shutdownPromise
  }

  reapProviderProcesses(kernel)
  reapOrphanShims(kernel.paths.runDir)
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

  const recoveryStore = kernel.services.use("store.api")
  if (recoveryStore) tools.reconcile(recoveryStore)
  queueMicrotask(() => void drain())

  return {
    enqueue,
    activeRun,
    continueAfterApproval,
    listRuns: persistence.listRuns,
    cancel,
    cancelBotTurns,
    retry,
    answerApproval,
    approvalBridge,
    approvalPrompt,
    listRoutines,
    listRoutineRuns,
    createRoutine,
    updateRoutine,
    runRoutine,
    tick,
    shutdown,
  }
}
