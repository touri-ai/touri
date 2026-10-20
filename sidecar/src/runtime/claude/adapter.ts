import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Kernel, MessagePart, ProviderAdapter, Result, RunErrorClass, StartTurnArgs } from "@touri/contracts"
import { approvalOutcome } from "../../approvals/outcome"
import { claudeApprovalKind, claudeApprovalPayload } from "../../approvals/payload"
import { buildChildEnv } from "../../kernel"
import { ensurePrivateDirectoryAsync, writePrivateFileAsync } from "../../kernel/async-files"
import { redactStructured } from "../../kernel/redact"
import { getSavedBotModel } from "../../store/model"
import { commandOutputTail, createCommandOutput } from "../command-output"
import { folderConfinementRequired, spawnFolderProvider, turnFolders } from "../folder-access"
import { loadTurnImages } from "../loadTurnImages"
import { withLocalTurnTemp } from "../local-turn-temp"
import { mcpStartupError, touriMcpStartupFailed } from "../mcp-startup"
import { applyProviderPrivacy, cliTelemetryOff } from "../privacy"
import { type ChildProcess, readProviderStderr, startLineReader, writeLine } from "../provider-io"
import { stopProviderChildren, trackProviderProcess } from "../provider-processes"
import { resolveProviderExecutable } from "../resolveProviderExecutable"
import { asRecord, classifyProviderError, resolveExecutable, stringValue } from "../utils"
import { claudeUserContent } from "./claudeUserContent"
import { claudeSettings } from "./settings"

type PendingApproval = { child: ChildProcess; toolUseId: string }

const inputText = (input: StartTurnArgs["input"]): string =>
  input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const shellTool = (name: string): boolean => name === "Bash" || name === "PowerShell"

const partFromContent = (value: unknown): MessagePart | null => {
  const content = asRecord(value)
  if (!content) return null
  const type = stringValue(content.type) ?? ""
  if (type === "tool_use") {
    return {
      type: "tool_call",
      callId: stringValue(content.id) ?? "claude-tool",
      tool: stringValue(content.name) ?? "tool",
      summary: `Claude tool ${stringValue(content.name) ?? "tool"}`,
      inputJson: JSON.stringify(content.input ?? {}),
      outputJson: null,
      ok: null,
    }
  }
  if (type === "text" && typeof content.text === "string") return { type: "text", text: content.text }
  return null
}

const permissionMode = (args: StartTurnArgs): string => {
  if (args.bot.access === "read-only") return "dontAsk"
  if (args.bot.access === "full" && args.bot.approvals === "never") return "bypassPermissions"
  return args.bot.approvals === "never" ? "acceptEdits" : "default"
}

const claudeConfig = async ({
  args,
  root,
  path,
}: {
  args: StartTurnArgs
  root: string
  path: string
}): Promise<void> => {
  await (args.execution?.writeFile ?? writePrivateFileAsync)({
    root,
    path,
    content: JSON.stringify({
      mcpServers: args.conversationOnly
        ? {}
        : {
            touri: { command: args.mcp.command, args: args.mcp.args, env: args.mcp.env },
          },
    }),
  })
}

export const createClaudeAdapter = ({
  kernel,
  command,
  interruptGraceMs = 2_000,
}: {
  kernel: Kernel
  command?: string
  interruptGraceMs?: number
}): ProviderAdapter => {
  const commandName = command ?? process.env.TOURI_CLAUDE_BIN ?? "claude"
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
      return { success: false, errorCode: "cli_auth", error: "Claude is not logged in" }
    return { success: true, path: resolved.path, version: stdout.trim().split(/\s+/)[0] ?? "unknown", loggedIn: true }
  }

  const startAttempt = async (
    args: StartTurnArgs,
  ): Promise<ReturnType<ProviderAdapter["startTurn"]> extends Promise<infer T> ? T : never> => {
    const env = args.execution ? { ...args.env } : buildChildEnv({ base: process.env, overrides: args.env })
    const resolved = args.execution
      ? { success: true as const, path: "claude", env }
      : await resolveProviderExecutable({ kernel, command: commandName, env })
    if (!resolved.success) return resolved
    if (resolved.env.PATH) env.PATH = resolved.env.PATH
    const loaded = loadTurnImages({ kernel, input: args.input })
    if (!loaded.success) return loaded
    const runDir = env.TOURI_RUN_DIR ?? kernel.paths.runDir
    const configPath = `${runDir}/claude/${args.thread.id}.mcp.json`
    const systemPath = `${runDir}/claude/${args.thread.id}.system.md`
    const settingsPath = `${runDir}/claude/${args.thread.id}.settings.json`
    const userSettings = await claudeSettings(args, env)
    for (const value of Object.values(userSettings.authEnv))
      if (typeof value === "string") kernel.addRedactionValue(value)
    Object.assign(env, userSettings.authEnv, args.env)
    Object.assign(env, applyProviderPrivacy(env, cliTelemetryOff(kernel)))
    await claudeConfig({ args, root: kernel.paths.appData, path: configPath })
    await (args.execution?.writeFile ?? writePrivateFileAsync)({
      root: kernel.paths.appData,
      path: settingsPath,
      content: JSON.stringify(userSettings.settings),
    })
    await (args.execution?.writeFile ?? writePrivateFileAsync)({
      root: kernel.paths.appData,
      path: systemPath,
      content: args.developerInstructions,
    })
    const sessionId = args.session?.externalSessionId ?? randomUUID()
    const commandArgs = [
      "-p",
      ...(args.conversationOnly ? ["--tools", ""] : []),
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      args.session ? "--resume" : "--session-id",
      sessionId,
      "--mcp-config",
      configPath,
      // claude.ai connectors only load without strict mode. They are an explicit per-bot opt-in for
      // local bots; their tool calls still go through the approval prompt, not the touri gateway.
      ...(args.bot.claudeAiConnectors && !args.execution ? [] : ["--strict-mcp-config"]),
      // Do not merge user/project/local permission rules or auto mode into a bot's policy.
      // Authentication still uses the CLI's normal credential store.
      "--setting-sources=",
      "--settings",
      settingsPath,
      "--append-system-prompt-file",
      systemPath,
      "--permission-mode",
      permissionMode(args),
      "--add-dir",
      args.bot.homeDir,
    ]
    if (args.bot.approvals === "on-request" && args.bot.access !== "read-only")
      commandArgs.push("--permission-prompt-tool", "mcp__touri__approval_prompt")
    if (args.bot.model) commandArgs.push("--model", args.bot.model)
    if (args.bot.reasoningEffort)
      commandArgs.push("--effort", args.bot.reasoningEffort === "xhigh" ? "max" : args.bot.reasoningEffort)
    const projectDataDir = env.TOURI_PROJECT_DATA_DIR
    if (projectDataDir) commandArgs.push("--add-dir", projectDataDir)
    if (!args.execution && env.TMPDIR) commandArgs.push("--add-dir", env.TMPDIR)
    for (const folder of turnFolders(args)) commandArgs.push("--add-dir", folder.path)
    if (process.platform !== "darwin" && folderConfinementRequired(args))
      await ensurePrivateDirectoryAsync({
        root: args.bot.homeDir,
        path: join(args.bot.homeDir, ".touri-claude"),
      })
    const spawned = spawnFolderProvider(kernel, args, {
      cmd: resolved.path,
      args: commandArgs,
      cwd: args.fingerprint.cwd,
      env: applyProviderPrivacy(env, cliTelemetryOff(kernel)),
    })
    if (!spawned.success)
      return {
        success: false,
        errorCode: spawned.errorCode === "ENOENT" ? "cli_missing" : "cli_crash",
        error: spawned.error,
      }
    children.add(spawned)
    void spawned.exited.then(() => children.delete(spawned))
    if (!args.execution) await trackProviderProcess(kernel, spawned)
    let completed = false
    let stopped = false
    const toolCalls = new Map<string, Extract<MessagePart, { type: "tool_call" }>>()
    const outputs = new Map<
      string,
      { stream: ReturnType<typeof createCommandOutput>; length: number; suffix: string }
    >()
    const streamedTools = new Map<number, { callId: string; json: string }>()
    const emitTool = (part: Extract<MessagePart, { type: "tool_call" }>): void => {
      const previous = toolCalls.get(part.callId)
      const next = {
        ...previous,
        ...part,
        ...(shellTool(part.tool)
          ? {
              startedAt: previous?.startedAt ?? Date.now(),
              outputMode: part.outputMode ?? previous?.outputMode ?? "on_completion",
            }
          : {}),
      } satisfies Extract<MessagePart, { type: "tool_call" }>
      toolCalls.set(part.callId, next)
      args.onEvent({ type: "item", part: next })
    }
    let sawText = false
    const thinkingBlocks = new Map<number, string>()
    let estimatedThinkingTokens = 0
    const emitThinking = (index: number, text: string): void => {
      if (!text) return
      thinkingBlocks.set(index, (thinkingBlocks.get(index) ?? "") + text)
      args.onEvent({ type: "reasoning_delta", itemId: `thinking-${index}`, delta: text })
    }
    let turnStarted = false
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
      stopReader()
      spawned.kill("SIGTERM")
      finish(result.success ? result : { ...result, error: kernel.redact(result.error) })
    }
    const input = args.handoffPacket ? `${args.handoffPacket}\n\n${inputText(args.input)}` : inputText(args.input)
    const onLine = (line: string): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch {
        complete({ success: false, errorCode: "cli_protocol", error: "Malformed Claude JSON frame" })
        return
      }
      const frame = asRecord(parsed)
      if (!frame) {
        complete({ success: false, errorCode: "cli_protocol", error: "Invalid Claude frame" })
        return
      }
      const type = stringValue(frame.type)
      if ((type === "system" || type === "error") && touriMcpStartupFailed(frame)) {
        complete({
          success: false,
          errorCode: "cli_protocol",
          error: mcpStartupError({ diagnostic: JSON.stringify(frame) }),
        })
        return
      }
      if (type === "system") {
        const subtype = stringValue(frame.subtype)
        if (subtype === "init" || frame.session_id) {
          args.onEvent({
            type: "session",
            externalSessionId: stringValue(frame.session_id) ?? sessionId,
            rolloutPath: null,
          })
          if (!turnStarted) {
            turnStarted = true
            args.onEvent({ type: "turn_started", externalTurnId: `claude-turn-${sessionId}` })
          }
        }
      } else if (type === "tool_progress" || type === "progress") {
        const data = asRecord(frame.data) ?? frame
        const callId = stringValue(frame.parentToolUseID) ?? stringValue(frame.tool_use_id)
        const call = callId ? toolCalls.get(callId) : null
        if (call && shellTool(call.tool) && call.ok === null) {
          const snapshot = stringValue(data.fullOutput)
          const partial = stringValue(data.output)
          if (snapshot !== null || partial !== null) {
            const output = outputs.get(call.callId) ?? {
              stream: createCommandOutput(kernel.redact),
              length: 0,
              suffix: "",
            }
            // Native progress carries cumulative fullOutput; output alone is a tail snapshot too.
            const text = snapshot ?? partial ?? ""
            if (
              snapshot === null ||
              text.length < output.length ||
              text.slice(output.length - output.suffix.length, output.length) !== output.suffix
            ) {
              output.stream = createCommandOutput(kernel.redact)
              output.length = 0
            }
            const delta = text.slice(output.length)
            output.length = text.length
            output.suffix = commandOutputTail(text)
            outputs.set(call.callId, output)
            emitTool({ ...call, outputMode: "streaming", outputTail: output.stream.append(delta) })
          }
        }
      } else if (type === "stream_event") {
        const event = asRecord(frame.event) ?? {}
        const delta = asRecord(event.delta)
        const index = typeof event.index === "number" ? event.index : 0
        if (event.type === "content_block_start") {
          const content = asRecord(event.content_block)
          if (content?.type === "thinking") {
            args.onEvent({ type: "reasoning_progress", estimatedTokens: estimatedThinkingTokens })
            emitThinking(index, stringValue(content.thinking) ?? "")
          }
          const part = partFromContent(event.content_block)
          if (part?.type === "tool_call") {
            streamedTools.set(index, { callId: part.callId, json: "" })
            emitTool(part)
          }
        }
        if (event.type === "content_block_delta" && delta?.type === "input_json_delta") {
          const stream = streamedTools.get(index)
          if (stream && typeof delta.partial_json === "string") stream.json += delta.partial_json
        }
        if (event.type === "content_block_stop") {
          const stream = streamedTools.get(index)
          const part = stream && toolCalls.get(stream.callId)
          if (part && stream?.json) emitTool({ ...part, inputJson: stream.json })
          streamedTools.delete(index)
        }
        if (stringValue(event.type) === "content_block_delta" && stringValue(delta?.type) === "text_delta") {
          const text = stringValue(delta?.text)
          if (text) {
            sawText = true
            args.onEvent({ type: "text_delta", itemId: stringValue(frame.index) ?? "assistant", delta: text })
          }
        }
        if (event.type === "content_block_delta" && delta?.type === "thinking_delta") {
          // Print mode can hide thinking text while still streaming token estimates.
          const tokens = delta.estimated_tokens
          if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
            estimatedThinkingTokens += tokens
            args.onEvent({ type: "reasoning_progress", estimatedTokens: estimatedThinkingTokens })
          }
          emitThinking(index, stringValue(delta.thinking) ?? "")
        }
      } else if (type === "assistant") {
        const message = asRecord(frame.message) ?? {}
        const content = Array.isArray(message.content) ? message.content : []
        for (const [index, item] of content.entries()) {
          const block = asRecord(item)
          if (block?.type === "thinking") {
            const text = stringValue(block.thinking) ?? ""
            const streamed = thinkingBlocks.get(index) ?? ""
            if (text.startsWith(streamed)) emitThinking(index, text.slice(streamed.length))
          }
          const part = partFromContent(item)
          if (part?.type === "tool_call") emitTool({ ...toolCalls.get(part.callId), ...part })
        }
        thinkingBlocks.clear()
      } else if (type === "user") {
        const content = asRecord(frame.message)?.content
        for (const value of Array.isArray(content) ? content : []) {
          const result = asRecord(value)
          if (result?.type !== "tool_result") continue
          const callId = stringValue(result.tool_use_id) ?? ""
          const call = toolCalls.get(callId)
          if (call)
            emitTool({
              ...call,
              ...(outputs.has(callId) ? { outputTail: outputs.get(callId)?.stream.flush() ?? "" } : {}),
              outputJson: typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? null),
              ok: result.is_error !== true,
            })
          outputs.delete(callId)
        }
      } else if (type === "approval_request") {
        const approvalId = stringValue(frame.approval_id) ?? stringValue(frame.id) ?? `claude-approval-${randomUUID()}`
        const toolUseId = stringValue(frame.tool_use_id) ?? approvalId
        const toolName = stringValue(frame.tool_name) ?? "Bash"
        approvals.set(approvalId, { child: spawned, toolUseId })
        args.onEvent({
          type: "approval_request",
          approvalId,
          part: {
            type: "approval",
            approvalId,
            request: claudeApprovalKind(toolName),
            scope: { source: "claude", tool: toolName },
            detail: JSON.stringify(
              redactStructured(
                claudeApprovalPayload(frame.input ?? {}, args.fingerprint.cwd, stringValue(frame.reason)),
                kernel.redact,
              ),
            ),
            decision: "pending",
          },
        })
      } else if (type === "result") {
        const isError = frame.is_error === true || stringValue(frame.subtype) === "error"
        const text = stringValue(frame.result) ?? ""
        if (!sawText && text && !isError) args.onEvent({ type: "text_delta", itemId: "result", delta: text })
        const usage = asRecord(frame.usage)
        if (usage) {
          const usageDelta: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}
          if (typeof usage.input_tokens === "number") usageDelta.inputTokens = usage.input_tokens
          if (typeof usage.output_tokens === "number") usageDelta.outputTokens = usage.output_tokens
          if (typeof frame.total_cost_usd === "number") usageDelta.costUsd = frame.total_cost_usd
          args.onEvent({ type: "usage", usage: usageDelta, contextTokens: null, contextWindow: null })
        }
        const providerError = isError ? text || "Claude reported an error" : null
        args.onEvent({
          type: "turn_completed",
          status: isError ? "failed" : stopped ? "interrupted" : "succeeded",
          errorClass: providerError ? classifyProviderError(providerError) : null,
          errorMessage: providerError ? kernel.redact(providerError) : null,
        })
        complete({
          success: true,
          externalSessionId: sessionId,
          rolloutPath: null,
          status: isError ? "failed" : stopped ? "interrupted" : "succeeded",
        })
      } else if (type === "error") {
        const message = stringValue(frame.message) ?? "Claude reported an error"
        complete({ success: false, errorCode: classifyProviderError(message), error: message })
      }
    }
    const stopReader = startLineReader({
      stream: spawned.stdout,
      onLine,
      onError: (error) => complete({ success: false, errorCode: "cli_protocol", error: error.message }),
    })
    void writeLine({
      stdin: spawned.stdin,
      value: {
        type: "user",
        message: { role: "user", content: claudeUserContent({ text: input, images: loaded.images }) },
      },
    }).catch((error) => complete({ success: false, errorCode: "cli_crash", error: errorText(error) }))
    let mcpError: string | null = null
    const stderrPromise = readProviderStderr(spawned.stderr, (text) => {
      if (touriMcpStartupFailed(text)) {
        mcpError = mcpStartupError({ diagnostic: text })
        complete({ success: false, errorCode: "cli_protocol", error: mcpError })
      }
    }).catch(() => "")
    const onExit = spawned.exited.then(({ code, signal }) => {
      if (!completed)
        complete({
          success: false,
          errorCode: stopped ? "canceled" : signal === "SIGKILL" ? "oom" : "cli_crash",
          error: `Claude exited (${signal ?? code ?? "unknown"})`,
        })
    })
    let finishCancellation: () => void = () => undefined
    const cancellationDeadline = new Promise<string>((resolve) => {
      finishCancellation = () => resolve("")
    })
    const abort = (): void => {
      if (stopped) return
      stopped = true
      spawned.kill("SIGINT")
      const killTimer = setTimeout(() => {
        spawned.kill("SIGKILL")
        complete({ success: false, errorCode: "canceled", error: "Turno cancelado" })
        finishCancellation()
      }, interruptGraceMs)
      // A tool may keep stderr open after the provider leader exits.
      void Promise.all([onExit, stderrPromise]).finally(() => clearTimeout(killTimer))
    }
    args.signal.addEventListener("abort", abort, { once: true })
    if (args.signal.aborted) abort()
    const output = await resultPromise
    const stderr = await Promise.race([stderrPromise, cancellationDeadline])
    args.signal.removeEventListener("abort", abort)
    if (mcpError) return { success: false, errorCode: "cli_protocol", error: mcpError }
    if (!completed && classifyProviderError(stderr) === "cli_auth")
      return { success: false, errorCode: "cli_auth", error: kernel.redact(stderr.trim()) }
    if (!completed) spawned.kill("SIGTERM")
    return output
  }

  const startTurn: ProviderAdapter["startTurn"] = async (args) => {
    const model = getSavedBotModel(args.bot.model)
    if (!model.success) return model

    const turnArgs = Object.assign({}, args, { bot: Object.assign({}, args.bot, { model: model.model }) })
    return withLocalTurnTemp(kernel, turnArgs, startAttempt)
  }

  const answerApproval = async ({
    approvalId,
    decision,
    message,
  }: {
    approvalId: string
    decision: "approved" | "denied"
    message?: string
  }): Promise<Result<object, "NOT_FOUND">> => {
    const approval = approvals.get(approvalId)
    if (!approval) return { success: false, errorCode: "NOT_FOUND", error: "Approval not found" }
    approvals.delete(approvalId)
    await writeLine({
      stdin: approval.child.stdin,
      value: {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: approval.toolUseId,
              content: message ?? (decision === "approved" ? approvalOutcome.once : approvalOutcome.denied),
              is_error: decision !== "approved",
            },
          ],
        },
      },
    })
    return { success: true }
  }

  const shutdown = async (): Promise<void> => {
    await stopProviderChildren(children)
  }

  return { provider: "claude", detect, startTurn, answerApproval, shutdown }
}
