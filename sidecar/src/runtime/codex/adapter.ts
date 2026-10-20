import type {
  ApprovalPart,
  CommandPart,
  FileChangePart,
  Kernel,
  MessagePart,
  ProviderAdapter,
  Result,
  RunErrorClass,
  StartTurnArgs,
} from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { codexApprovalPayload } from "../../approvals/payload"
import { buildChildEnv } from "../../kernel"
import type { PerformanceStageRunner } from "../../kernel/performance"
import { redactStructured } from "../../kernel/redact"
import { getSavedBotModel } from "../../store/model"
import { touriVersion } from "../../version"
import { createCommandOutput } from "../command-output"
import { spawnFolderProvider } from "../folder-access"
import { loadTurnImages } from "../loadTurnImages"
import { withLocalTurnTemp } from "../local-turn-temp"
import { MCP_STARTUP_MESSAGE, mcpStartupError, touriMcpStartupFailed } from "../mcp-startup"
import { applyProviderPrivacy, cliTelemetryOff, providerPrivacyConfig } from "../privacy"
import { type ChildProcess, readProviderStderr, startLineReader, writeLine } from "../provider-io"
import { stopProviderChildren, trackProviderProcess } from "../provider-processes"
import { resolveProviderExecutable } from "../resolveProviderExecutable"
import { asRecord, classifyProviderError, resolveExecutable, stringValue } from "../utils"
import { codexInputItems } from "./codexInputItems"
import { codexAccessParams, outerFolderSandbox } from "./config"

type RpcResponse = { id: number; result?: unknown; error?: { message?: string } }

const TOURI_TOOLS_APPROVAL_MODE = "approve"

// Server requests Touri has no UI for. Each one gets an immediate answer so the
// CLI never waits forever on a request nobody can see (a hung tool call).
const unansweredServerRequest = (method: string): { result: unknown } | { error: { code: number; message: string } } =>
  method === "mcpServer/elicitation/request"
    ? { result: { action: "decline", content: null } }
    : { error: { code: -32601, message: `Touri não atende ${method}` } }
type PendingApproval = { child: ChildProcess; requestId: number | string; threadId: string; part: ApprovalPart }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const sandboxStartupFailed = (text: string): boolean =>
  /sandbox[^\n]*(?:failed to (?:start|initialize|launch)|initialization failed)|failed to (?:start|initialize|launch)[^\n]*sandbox|sandbox-exec:\s*(?:sandbox_apply|sandbox_init)[^\n]*(?:denied|not permitted)/i.test(
    text,
  )

// app-server carries structured errors in both ErrorNotification and Turn.
const codexErrorText = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null
  const record = asRecord(value)
  if (!record) return null
  const message = stringValue(record.message) ?? stringValue(record.errorMessage)
  const nested = codexErrorText(record.error)
  const detail = stringValue(record.additionalDetails) ?? stringValue(record.details)
  const pieces = [message, nested, detail].filter((piece): piece is string => !!piece?.trim())
  return pieces.length ? [...new Set(pieces)].join(" · ") : null
}

const responseRecord = (value: unknown): RpcResponse | null => {
  const record = asRecord(value)
  if (!record || typeof record.id !== "number" || typeof record.method === "string") return null
  const errorRecord = asRecord(record.error)
  const errorMessage = codexErrorText(record.error)
  return errorRecord
    ? { id: record.id, result: record.result, error: errorMessage ? { message: errorMessage } : {} }
    : { id: record.id, result: record.result }
}

const partFromItem = (value: unknown, completed = false): MessagePart | null => {
  const item = asRecord(value)
  if (!item) return null
  const type = (stringValue(item.type) ?? "").toLowerCase()
  const callId = stringValue(item.callId) ?? stringValue(item.id) ?? "unknown"
  if (type.includes("command")) {
    const command = stringValue(item.command) ?? stringValue(item.commandLine) ?? ""
    return {
      type: "command",
      callId,
      command,
      cwd: stringValue(item.cwd) ?? "",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      outputTail: stringValue(item.aggregatedOutput) ?? stringValue(item.output) ?? stringValue(item.outputTail) ?? "",
    } satisfies CommandPart
  }
  if (type.includes("file") && type.includes("change")) {
    const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : []
    const paths = Array.isArray(item.paths)
      ? item.paths.filter((path): path is string => typeof path === "string")
      : changes.flatMap((change) => (typeof change?.path === "string" ? [change.path] : []))
    return {
      type: "file_change",
      callId,
      paths,
      diff:
        stringValue(item.diff) ??
        (changes
          .map((change) => stringValue(change?.diff) ?? "")
          .filter(Boolean)
          .join("\n") ||
          null),
      resolution:
        item.status === "failed" || item.error
          ? "failed"
          : item.status === "canceled"
            ? "canceled"
            : item.status === "interrupted"
              ? "interrupted"
              : completed || item.status === "completed"
                ? "succeeded"
                : "running",
    } satisfies FileChangePart
  }
  if (type.includes("mcp") || type.includes("tool")) {
    return {
      type: "tool_call",
      callId,
      tool: stringValue(item.tool) ?? stringValue(item.name) ?? "tool",
      summary: stringValue(item.summary) ?? "MCP tool call",
      inputJson:
        typeof (item.arguments ?? item.input) === "string"
          ? String(item.arguments ?? item.input)
          : JSON.stringify(item.arguments ?? item.input ?? {}),
      outputJson:
        typeof (item.result ?? item.output ?? item.error) === "string"
          ? String(item.result ?? item.output ?? item.error)
          : item.result !== undefined || item.output !== undefined || item.error !== undefined
            ? JSON.stringify(item.result ?? item.output ?? item.error)
            : null,
      ok:
        typeof item.ok === "boolean"
          ? item.ok
          : item.status === "completed"
            ? !item.error
            : item.status === "failed"
              ? false
              : null,
    }
  }
  return null
}

const sessionDetails = (value: unknown): { id: string; rolloutPath: string | null } => {
  const result = asRecord(value) ?? {}
  const thread = asRecord(result.thread) ?? {}
  return {
    id: stringValue(thread.id) ?? stringValue(result.threadId) ?? stringValue(result.id) ?? "codex-session",
    rolloutPath:
      stringValue(result.rolloutPath) ??
      stringValue(result.rollout_path) ??
      stringValue(thread.rolloutPath) ??
      stringValue(thread.path),
  }
}

const codexArgs = ({ args, mcp }: { args: StartTurnArgs; mcp: StartTurnArgs["mcp"] }): Array<string> => {
  const result = [
    "app-server",
    "--stdio",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "computer_use",
    "-c",
    "check_for_update_on_startup=false",
    // A user's auto-review setting must not answer Touri's approval requests.
    "-c",
    'approvals_reviewer="user"',
    "-c",
    `mcp_servers.touri.command=${mcp.command}`,
    "-c",
    `mcp_servers.touri.args=${JSON.stringify(mcp.args)}`,
  ]
  // External integrations are forwarded by touri so their policies cannot be bypassed.
  // Touri enforces each tool's consent itself (MCP policy gate); a second Codex prompt
  // for the touri server has no UI and would hold every tool call forever.
  result.push(
    "-c",
    `mcp_servers={touri={command=${JSON.stringify(mcp.command)},args=${JSON.stringify(mcp.args)},default_tools_approval_mode="${TOURI_TOOLS_APPROVAL_MODE}"}}`,
  )
  if (args.conversationOnly)
    result.push(
      "-c",
      "mcp_servers={}",
      "--disable",
      "shell_tool",
      "--disable",
      "apply_patch_freeform",
      "--disable",
      "view_image",
      "--disable",
      "image_generation",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "code_mode",
      "--disable",
      "code_mode_host",
      "--disable",
      "multi_agent",
      "-c",
      "tools.view_image=false",
      "-c",
      'web_search="disabled"',
    )
  if (args.bot.access === "full")
    result.push(
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      `approval_policy=${JSON.stringify(args.bot.approvals)}`,
    )
  else if (args.bot.access === "read-only")
    // On macOS touri's Seatbelt profile is the boundary (see codexAccessParams).
    result.push(
      "-c",
      outerFolderSandbox(args) ? 'sandbox_mode="danger-full-access"' : 'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
    )
  return args.bot.model ? [...result, "-c", `model=${JSON.stringify(args.bot.model)}`] : result
}

export const createCodexAdapter = ({
  kernel,
  command,
  interruptGraceMs = 2_000,
  runStage,
}: {
  kernel: Kernel
  command?: string
  interruptGraceMs?: number
  runStage?: PerformanceStageRunner
}): ProviderAdapter => {
  const commandName = command ?? process.env.TOURI_CODEX_BIN ?? "codex"
  const approvals = new Map<string, PendingApproval>()
  const children = new Set<ChildProcess>()

  const detect = async (): Promise<
    Result<{ path: string; version: string; loggedIn: boolean }, "cli_missing" | "cli_auth">
  > => {
    const env = applyProviderPrivacy(
      buildChildEnv({ base: commandName.startsWith("/") ? process.env : await kernel.shellEnv() }),
      cliTelemetryOff(kernel),
    )
    const resolved = resolveExecutable({ command: commandName, env })
    if (!resolved.success) return resolved
    const spawned = kernel.spawnTree({ cmd: resolved.path, args: ["--version"], cwd: process.cwd(), env })
    if (!spawned.success)
      return {
        success: false,
        errorCode: spawned.errorCode === "ENOENT" ? "cli_missing" : "cli_auth",
        error: spawned.error,
      }
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
    ])
    await spawned.exited
    const combined = `${stdout}\n${stderr}`
    if (classifyProviderError(combined) === "cli_auth")
      return { success: false, errorCode: "cli_auth", error: "Codex is not logged in" }
    return { success: true, path: resolved.path, version: stdout.trim().split(/\s+/)[0] ?? "unknown", loggedIn: true }
  }

  const startAttempt = async (
    args: StartTurnArgs,
    canRetrySandbox: () => boolean,
    onTurnSubmitted: () => void,
  ): Promise<ReturnType<ProviderAdapter["startTurn"]> extends Promise<infer T> ? T : never> => {
    const env = applyProviderPrivacy(
      args.execution ? args.env : buildChildEnv({ base: process.env, overrides: args.env }),
      cliTelemetryOff(kernel),
    )
    const resolved = args.execution
      ? { success: true as const, path: "codex", env }
      : await resolveProviderExecutable({ kernel, command: commandName, env })
    if (!resolved.success) return resolved
    const spawned = spawnFolderProvider(kernel, args, {
      cmd: resolved.path,
      args: [...codexArgs({ args, mcp: args.mcp }), ...providerPrivacyConfig(cliTelemetryOff(kernel))],
      cwd: args.fingerprint.cwd,
      env: resolved.env,
    })
    if (!spawned.success)
      return {
        success: false,
        errorCode: spawned.errorCode === "ENOENT" ? "cli_missing" : "cli_crash",
        error: spawned.error,
      }
    children.add(spawned)
    const expireApprovals = () => {
      for (const [id, approval] of approvals)
        if (approval.child === spawned) {
          approvals.delete(id)
          args.onEvent({
            type: "approval_request",
            approvalId: id,
            part: { ...approval.part, decision: "expired", resolvedAt: Date.now() },
          })
        }
    }
    void spawned.exited.then(() => {
      children.delete(spawned)
      expireApprovals()
    })
    if (!args.execution) await trackProviderProcess(kernel, spawned)
    let mcpError: string | null = null
    let stopped = false
    let completed = false
    let externalSessionId = args.session?.externalSessionId ?? "codex-session"
    let rolloutPath: string | null = args.session?.rolloutPath ?? null
    let turnId: string | null = null
    let resuming = false
    const classifyError = (message: string): RunErrorClass => {
      const errorClass = classifyProviderError(message)
      const failedRecovery = /failed to recover|rollout.*not found|unable to load session/i.test(message)
      return resuming && errorClass !== "cli_auth" && failedRecovery ? "cli_protocol" : errorClass
    }
    const agentTexts = new Map<string, string>()
    const commands = new Map<string, { part: CommandPart; output: ReturnType<typeof createCommandOutput> }>()
    const approvalItems = new Map<string, Record<string, unknown>>()
    const emitAgentText = (itemId: string, delta: string): void => {
      if (!delta) return
      agentTexts.set(itemId, (agentTexts.get(itemId) ?? "") + delta)
      args.onEvent({ type: "text_delta", itemId, delta })
    }
    let nextRequestId = 1
    const responseWaiters = new Map<
      number,
      { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
    >()
    const sendRequest = (method: string, params: unknown): Promise<RpcResponse> => {
      const id = nextRequestId++
      return new Promise((resolve, reject) => {
        responseWaiters.set(id, { resolve, reject })
        void writeLine({ stdin: spawned.stdin, value: { jsonrpc: "2.0", id, method, params } }).catch((error) => {
          responseWaiters.delete(id)
          reject(error)
        })
      })
    }
    const interrupt = (): void => {
      if (turnId) void sendRequest("turn/interrupt", { threadId: externalSessionId, turnId }).catch(() => undefined)
    }
    let finish: (
      result:
        | {
            success: true
            externalSessionId: string
            rolloutPath: string | null
            status: "succeeded" | "failed" | "interrupted"
          }
        | { success: false; errorCode: RunErrorClass; error: string },
    ) => void = () => undefined
    const resultPromise = new Promise<ReturnType<ProviderAdapter["startTurn"]> extends Promise<infer T> ? T : never>(
      (resolve) => {
        finish = resolve
      },
    )
    const complete = (result: Parameters<typeof finish>[0]): void => {
      if (completed) return
      completed = true
      expireApprovals()
      for (const waiter of responseWaiters.values()) waiter.reject(new Error("Codex turn ended"))
      responseWaiters.clear()
      stopReader()
      spawned.kill("SIGTERM")
      finish(result.success ? result : { ...result, error: kernel.redact(result.error) })
    }
    const recoverSandbox = (message: string): boolean => {
      if (!canRetrySandbox() || args.signal.aborted || !sandboxStartupFailed(message)) return false
      complete({ success: false, errorCode: "cli_crash", error: message })
      return true
    }
    const parseFrame = (line: string): unknown => JSON.parse(line)
    const onLine = (line: string): void => {
      if (completed) return
      let parsed: unknown
      try {
        parsed = runStage ? runStage("provider_frame_json_parse", parseFrame, line) : parseFrame(line)
      } catch {
        complete({ success: false, errorCode: "cli_protocol", error: "Malformed Codex JSON frame" })
        return
      }
      if (runStage) runStage("provider_frame_route", routeFrame, parsed)
      else routeFrame(parsed)
    }
    const routeFrame = (parsed: unknown): void => {
      const response = responseRecord(parsed)
      if (response) {
        const waiter = responseWaiters.get(response.id)
        if (waiter) {
          responseWaiters.delete(response.id)
          if (response.error) waiter.reject(new Error(response.error.message ?? "Codex request failed"))
          else waiter.resolve(response)
        }
        return
      }
      const frame = asRecord(parsed)
      if (!frame) {
        complete({ success: false, errorCode: "cli_protocol", error: "Invalid Codex frame" })
        return
      }
      const method = stringValue(frame.method)
      const params = asRecord(frame.params) ?? {}
      if (method && /mcp|warning|error|codex\/event/i.test(method) && touriMcpStartupFailed(frame)) {
        complete({
          success: false,
          errorCode: "cli_protocol",
          error: mcpStartupError({ diagnostic: JSON.stringify(frame) }),
        })
        return
      }
      if (method === "turn/started") {
        turnId = stringValue(params.turnId) ?? stringValue(asRecord(params.turn)?.id) ?? stringValue(params.id)
        if (turnId) args.onEvent({ type: "turn_started", externalTurnId: turnId })
        if (stopped) interrupt()
      } else if (method === "item/agentMessage/delta") {
        const delta = stringValue(params.delta) ?? stringValue(asRecord(params.item)?.delta)
        if (delta) emitAgentText(stringValue(params.itemId) ?? stringValue(asRecord(params.item)?.id) ?? "agent", delta)
      } else if (method === "item/reasoning/summaryTextDelta") {
        const delta = stringValue(params.delta) ?? ""
        if (delta) args.onEvent({ type: "reasoning_delta", itemId: stringValue(params.itemId) ?? "reasoning", delta })
      } else if (method === "item/commandExecution/outputDelta") {
        const callId = stringValue(params.itemId)
        const command = callId ? commands.get(callId) : null
        const delta = stringValue(params.delta)
        if (command && delta) {
          command.part = { ...command.part, outputTail: command.output.append(delta) }
          args.onEvent({ type: "item", part: command.part })
        }
      } else if (method === "item/started" || method === "item/completed") {
        const item = asRecord(params.item ?? params)
        const itemId = stringValue(item?.id) ?? stringValue(item?.callId)
        if (method === "item/started" && item && itemId && /command|file.*change/i.test(stringValue(item.type) ?? ""))
          approvalItems.set(itemId, item)
        if (method === "item/completed" && itemId) approvalItems.delete(itemId)
        if (method === "item/completed" && (item?.type === "agentMessage" || item?.type === "agent_message")) {
          const itemId = stringValue(item.id) ?? "agent"
          const text = stringValue(item.text) ?? ""
          const streamed = agentTexts.get(itemId) ?? ""
          // Some app-server clients supply only a completed item, or omit its last delta.
          if (text.startsWith(streamed)) emitAgentText(itemId, text.slice(streamed.length))
        }
        let part = partFromItem(params.item ?? params, method === "item/completed")
        if (part?.type === "command") {
          const previous = commands.get(part.callId)
          const output = previous?.output ?? createCommandOutput(kernel.redact)
          const completed = method === "item/completed"
          const finalOutput = completed ? output.flush() : ""
          part = {
            ...part,
            command: part.command || previous?.part.command || "",
            cwd: part.cwd || previous?.part.cwd || "",
            startedAt: previous?.part.startedAt ?? Date.now(),
            outputMode: "streaming",
            outputTail: part.outputTail
              ? completed
                ? redactToolText(part.outputTail, kernel.redact)
                : output.append(part.outputTail)
              : finalOutput || previous?.part.outputTail || "",
          }
          if (completed) commands.delete(part.callId)
          else commands.set(part.callId, { part, output })
        }
        if (
          method === "item/completed" &&
          part?.type === "command" &&
          part.exitCode !== 0 &&
          recoverSandbox(part.outputTail)
        ) {
          args.onEvent({ type: "item", part })
          return
        }
        if (part) args.onEvent({ type: "item", part })
      } else if (method === "turn/usage" || method === "usage") {
        const usage = asRecord(params.usage) ?? params
        args.onEvent({
          type: "usage",
          usage: {
            ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
            ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
            ...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
            ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
          },
          contextTokens: typeof usage.contextTokens === "number" ? usage.contextTokens : null,
          contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : null,
        })
      } else if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "item/permissions/requestApproval"
      ) {
        if (recoverSandbox(stringValue(params.reason) ?? "")) return
        if (typeof frame.id !== "number" && typeof frame.id !== "string") {
          complete({
            success: false,
            errorCode: "cli_protocol",
            error: "Codex enviou uma aprovação sem identificador RPC.",
          })
          return
        }
        const approvalId = kernel.newId()
        const request = method.includes("fileChange")
          ? "file_change"
          : method.includes("permissions")
            ? "permission"
            : "command"
        const part = {
          type: "approval",
          approvalId,
          request,
          detail: JSON.stringify(
            redactStructured(
              codexApprovalPayload(params, approvalItems.get(stringValue(params.itemId) ?? ""), args.fingerprint.cwd),
              kernel.redact,
            ),
          ),
          decision: "pending",
        } as const
        approvals.set(approvalId, { child: spawned, requestId: frame.id, threadId: args.thread.id, part })
        args.onEvent({ type: "approval_request", approvalId, part })
      } else if (
        method &&
        (typeof frame.id === "number" || typeof frame.id === "string") &&
        method !== "turn/completed"
      ) {
        kernel.log({
          level: "warn",
          module: "codex",
          msg: "Codex: pedido sem suporte recusado",
          data: { method, threadId: args.thread.id },
        })
        void writeLine({
          stdin: spawned.stdin,
          value: { jsonrpc: "2.0", id: frame.id, ...unansweredServerRequest(method) },
        }).catch(() => undefined)
      } else if (method === "turn/completed") {
        const turn = asRecord(params.turn) ?? {}
        const statusText = stringValue(params.status) ?? stringValue(turn.status) ?? "succeeded"
        const status =
          statusText === "interrupted"
            ? "interrupted"
            : statusText === "failed" || params.error || turn.error
              ? "failed"
              : "succeeded"
        const providerError = codexErrorText(params) ?? codexErrorText(turn)
        if (status === "failed" && recoverSandbox(providerError ?? "")) return
        const errorMessage = providerError === null ? null : kernel.redact(providerError)
        args.onEvent({
          type: "turn_completed",
          status,
          errorClass: status === "succeeded" ? null : classifyProviderError(providerError ?? statusText),
          errorMessage: errorMessage ?? (status === "failed" ? "Codex reported an error" : null),
        })
        complete({ success: true, externalSessionId, rolloutPath, status })
      } else if (method === "error") {
        const message = codexErrorText(params) ?? `Erro do Codex: ${kernel.redact(JSON.stringify(params))}`
        if (params.willRetry === true) {
          kernel.log({
            level: "warn",
            module: "codex",
            msg: "Codex: nova tentativa",
            data: { error: kernel.redact(message), threadId: args.thread.id },
          })
          return
        }
        complete({ success: false, errorCode: classifyError(message), error: message })
      } else if (method?.includes("fatal")) {
        const message = codexErrorText(params) ?? `Erro fatal do Codex: ${kernel.redact(JSON.stringify(params))}`
        complete({ success: false, errorCode: classifyError(message), error: message })
      }
    }
    const stopReader = startLineReader({
      stream: spawned.stdout,
      onLine: (line) => (runStage ? runStage("provider_frame_dispatch", onLine, line) : onLine(line)),
      onError: (error) => complete({ success: false, errorCode: "cli_protocol", error: error.message }),
      ...(runStage ? { runStage } : {}),
    })
    const stderrOutput = readProviderStderr(spawned.stderr, (text) => {
      if (recoverSandbox(text)) return
      if (touriMcpStartupFailed(text)) {
        mcpError = mcpStartupError({ diagnostic: text })
        complete({ success: false, errorCode: "cli_protocol", error: mcpError })
      }
    }).catch(() => "")
    void (async () => {
      try {
        await sendRequest("initialize", { clientInfo: { name: "touri", version: touriVersion } })
        if (completed) return
        args.signal.throwIfAborted()

        const access = codexAccessParams(args)
        // Native resumes can carry a previous run's MCP arguments. Always override
        // the persisted configuration with this turn's credential before turn/start.
        const turnConfig = {
          ...access,
          config: {
            ...asRecord(access.config),
            ...(cliTelemetryOff(kernel)
              ? {
                  analytics: { enabled: false },
                  otel: { exporter: "none", trace_exporter: "none", metrics_exporter: "none", log_user_prompt: false },
                }
              : {}),
            mcp_servers: args.conversationOnly
              ? {}
              : {
                  touri: {
                    command: args.mcp.command,
                    args: args.mcp.args,
                    env: args.mcp.env,
                    default_tools_approval_mode: TOURI_TOOLS_APPROVAL_MODE,
                  },
                },
          },
        }
        const sessionRequest = args.session
          ? {
              threadId: args.session.externalSessionId,
              path: args.session.rolloutPath,
              cwd: args.fingerprint.cwd,
              developerInstructions: args.developerInstructions,
              ...turnConfig,
            }
          : {
              cwd: args.fingerprint.cwd,
              developerInstructions: args.developerInstructions,
              ephemeral: false,
              ...turnConfig,
            }
        resuming = !!args.session
        const sessionResponse = await sendRequest(resuming ? "thread/resume" : "thread/start", sessionRequest)
        if (completed) return
        resuming = false
        args.signal.throwIfAborted()

        const details = sessionDetails(sessionResponse.result)
        externalSessionId = details.id
        rolloutPath =
          details.rolloutPath ??
          (args.session?.externalSessionId === externalSessionId ? args.session.rolloutPath : null)
        args.onEvent({ type: "session", externalSessionId, rolloutPath })
        const loaded = loadTurnImages({ kernel, input: args.input })
        if (!loaded.success) {
          complete({ success: false, errorCode: loaded.errorCode, error: loaded.error })
          return
        }
        // Once submitted, the task may have effects even before its acknowledgement arrives.
        onTurnSubmitted()
        const turnResponse = await sendRequest("turn/start", {
          threadId: externalSessionId,
          input: codexInputItems({
            input: args.input,
            images: loaded.images,
            ...(args.handoffPacket ? { textPrefix: args.handoffPacket } : {}),
          }),
          cwd: args.fingerprint.cwd,
          summary: "auto",
          ...(args.bot.reasoningEffort ? { effort: args.bot.reasoningEffort } : {}),
        })
        turnId ??= stringValue(asRecord(asRecord(turnResponse.result)?.turn)?.id)
        if (stopped) interrupt()
      } catch (error) {
        const message = errorText(error)
        const errorClass = classifyProviderError(message)
        complete({
          success: false,
          errorCode:
            errorClass === "cli_auth"
              ? errorClass
              : resuming || message.toLowerCase().includes("resume") || message.toLowerCase().includes("not found")
                ? "cli_protocol"
                : errorClass,
          error: message,
        })
      }
      const output = await stderrOutput
      if (!completed && output.trim()) {
        const errorClass = classifyProviderError(output)
        if (errorClass === "cli_auth") complete({ success: false, errorCode: "cli_auth", error: output.trim() })
      }
    })()
    const onExit = spawned.exited.then(async ({ code, signal }) => {
      const stderr = (await stderrOutput.catch(() => "")).trim()
      const errorClass = classifyError(stderr)
      if (!completed)
        complete({
          success: false,
          errorCode: stopped
            ? "canceled"
            : errorClass !== "unknown"
              ? errorClass
              : signal === "SIGKILL" || code === 137
                ? "oom"
                : "cli_crash",
          error: `Codex exited (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
        })
    })
    let finishCancellation: () => void = () => undefined
    const cancellationDeadline = new Promise<string>((resolve) => {
      finishCancellation = () => resolve("")
    })
    const abort = (): void => {
      if (stopped) return
      stopped = true
      if (!completed) interrupt()
      const killTimer = setTimeout(() => {
        spawned.kill("SIGKILL")
        complete({ success: false, errorCode: "canceled", error: "Turno cancelado" })
        finishCancellation()
      }, interruptGraceMs)
      // A tool may keep stderr open after the provider leader exits.
      void Promise.all([onExit, stderrOutput]).finally(() => clearTimeout(killTimer))
    }
    args.signal.addEventListener("abort", abort, { once: true })
    if (args.signal.aborted) abort()
    const output = await resultPromise
    await Promise.race([stderrOutput, cancellationDeadline])
    args.signal.removeEventListener("abort", abort)
    if (mcpError) return { success: false, errorCode: "cli_protocol", error: mcpError }
    if (!completed) spawned.kill("SIGTERM")
    return output
  }

  const startTurn: ProviderAdapter["startTurn"] = async (args) => {
    const model = getSavedBotModel(args.bot.model)
    if (!model.success) return model

    const turnArgs = Object.assign({}, args, { bot: Object.assign({}, args.bot, { model: model.model }) })
    let canRetry = !args.execution
    let canRetryTools = true
    const invoke = () =>
      withLocalTurnTemp(kernel, turnArgs, (turn) =>
        startAttempt(
          {
            ...turn,
            onEvent: (event) => {
              // Never replay completed actions or an approval the user has already seen.
              if (
                event.type === "approval_request" ||
                (event.type === "item" &&
                  !(
                    event.part.type === "command" &&
                    (event.part.exitCode === null ||
                      (event.part.exitCode !== 0 && sandboxStartupFailed(event.part.outputTail)))
                  ))
              )
                canRetry = false
              args.onEvent(event)
            },
          },
          () => canRetry,
          () => {
            canRetryTools = false
          },
        ),
      )
    const result = await invoke()
    if (result.success || args.signal.aborted) return result
    if (canRetryTools && result.error === `${MCP_STARTUP_MESSAGE} [etapa: handshake_timeout]`) {
      kernel.log({ level: "warn", module: "codex", msg: "Reiniciando as ferramentas antes de enviar o pedido" })
      return invoke()
    }
    if (!canRetry || !sandboxStartupFailed(result.error)) return result

    canRetry = false
    kernel.log({ level: "warn", module: "codex", msg: "Codex: reiniciando o sandbox com pasta temporária privada" })
    return invoke()
  }

  const answerApproval = async ({
    approvalId,
    decision,
  }: {
    approvalId: string
    decision: "approved" | "denied"
  }): Promise<Result<object, "NOT_FOUND">> => {
    const approval = approvals.get(approvalId)
    if (!approval) return { success: false, errorCode: "NOT_FOUND", error: "Approval not found" }
    approvals.delete(approvalId)
    await writeLine({
      stdin: approval.child.stdin,
      value: {
        jsonrpc: "2.0",
        id: approval.requestId,
        result: { decision: decision === "approved" ? "accept" : "decline" },
      },
    })
    return { success: true }
  }

  const shutdown = async (): Promise<void> => {
    await stopProviderChildren(children)
  }

  return { provider: "codex", detect, startTurn, answerApproval, shutdown }
}
