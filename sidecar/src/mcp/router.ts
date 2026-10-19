import type { Bot, Id, Kernel, ToolHandler, ToolRegistration, ToolResult } from "@touri/contracts"
import { toolCatalog, validateToolArgs } from "@touri/contracts"
import { approvalDestination } from "../approvals/grants"
import { hiddenInGroupSession } from "../groups/privacy"
import { delegatedBot, getDelegation } from "../groups/security"
import { redactStructured } from "../kernel/redact"
import { learningToolHidden } from "../learning/settings"
import { mem0SessionAllowed } from "../mem0/session"
import { capabilitySupport } from "../projects/capability-support"
import { createProjectStore } from "../projects/repository"
import { getTeamBuilder } from "../teams/eligibility"
import { auditToolCall } from "./audit"
import type { McpCallerContext } from "./auth"
import { attachedTools, forwardTool } from "./forward"
import { CONSENT_REQUIRED_TOOLS, requiresPolicyGate } from "./policyGate"
import type { JsonRpcId } from "./protocol"

type CatalogTool = (typeof toolCatalog.tools)[number]
type ToolMetadata = {
  group: string
  mvp: boolean
  internal?: boolean
  providers?: Array<string>
  deadlineMs?: number
  mutates?: boolean
}

type ToolCallParams = { id: JsonRpcId; name: string; args: unknown; caller: McpCallerContext; signal: AbortSignal }

const toolMetadata = (tool: CatalogTool): ToolMetadata => tool["x-touri"] as ToolMetadata

const isExperimental = (kernel: Kernel): boolean => {
  try {
    const row = (kernel.db as { query: (sql: string) => { get: () => unknown } })
      .query("SELECT value_json FROM settings WHERE key = 'experimentalTools'")
      .get()
    if (typeof row !== "object" || row === null || !("value_json" in row)) return false
    const value = (row as { value_json: unknown }).value_json
    return typeof value === "string" && JSON.parse(value) === true
  } catch {
    return false
  }
}

const effectiveBot = (kernel: Kernel, caller: McpCallerContext): Bot | null => {
  const bot = kernel.services.use("store.api")?.getBot({ botId: caller.botId })
  return bot ? delegatedBot(kernel, caller.threadId, bot) : null
}

const delegatedCaller = (kernel: Kernel, caller: McpCallerContext): McpCallerContext => {
  if (!getDelegation(kernel, caller.threadId)) return caller
  const effective = effectiveBot(kernel, caller)
  return {
    ...caller,
    browserEnabled: caller.browserEnabled && !!effective?.browserEnabled,
    computerUse: caller.computerUse && !!effective?.computerUse,
  }
}

const hostEscalation = (kernel: Kernel, caller: McpCallerContext, group: string): boolean => {
  if (group !== "computer") return false
  const stored = kernel.services.use("store.api")?.getBot({ botId: caller.botId })
  const effective = effectiveBot(kernel, caller)
  return !!stored && !!effective && stored.hostComputerUse && !effective.hostComputerUse
}

const visibleTo = ({
  tool,
  caller,
  experimental,
  kernel,
}: {
  tool: CatalogTool
  caller: McpCallerContext
  experimental: boolean
  kernel: Kernel
}): boolean => {
  if (tool.name === "team_create" && !getTeamBuilder(kernel, caller)) return false
  if (
    ["coordinate_bots", "ask_bot", "ask_all"].includes(tool.name) &&
    !kernel.services.use("groups.runtime")?.canCoordinate(caller.threadId)
  )
    return false
  if (hiddenInGroupSession(kernel, caller.threadId, tool.name)) return false
  if (
    tool.name.startsWith("mem0_") &&
    (!kernel.services.use("mem0.api")?.enabled(caller.botId) || !mem0SessionAllowed(kernel, caller.threadId))
  )
    return false
  if (learningToolHidden(kernel, caller.botId, tool.name)) return false
  const meta = toolMetadata(tool)
  if (!experimental && !meta.mvp) return false
  if (meta.internal && caller.provider !== "claude") return false
  if (meta.providers && !meta.providers.includes(caller.provider)) return false
  if (meta.group === "browser" && !caller.browserEnabled) return false
  if (meta.group === "computer" && !caller.computerUse) return false
  // Keep preview_open callable so an unlinked bot receives the setup requirement.
  if (!caller.projectId && ["process", "secret"].includes(meta.group)) return false
  if (meta.group === "secret" && getDelegation(kernel, caller.threadId)?.secrets === false) return false
  if (hostEscalation(kernel, caller, meta.group)) return false
  return true
}

const error = (errorCode: string, message: string): ToolResult => ({ success: false, errorCode, error: message })

const withDeadline = async ({
  handler,
  caller,
  runId,
  args,
  deadlineMs,
  signal,
}: {
  handler: ToolHandler
  caller: McpCallerContext
  runId: Id | null
  args: unknown
  deadlineMs: number
  signal: AbortSignal
}): Promise<ToolResult> => {
  const controller = new AbortController()
  let disconnected: ((result: ToolResult) => void) | undefined
  const abortFromConnection = (): void => {
    controller.abort()
    disconnected?.(error("CLIENT_DISCONNECTED", "MCP client disconnected"))
  }
  if (signal.aborted) return error("CLIENT_DISCONNECTED", "MCP client disconnected")
  signal.addEventListener("abort", abortFromConnection, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const handlerPromise = Promise.resolve().then(() =>
      handler({
        ctx: { ...caller, runId, signal: controller.signal },
        args,
      }),
    )
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(error("DEADLINE_EXCEEDED", `Tool exceeded its ${deadlineMs}ms deadline`))
      }, deadlineMs)
    })
    const disconnectedPromise = new Promise<ToolResult>((resolve) => {
      disconnected = resolve
    })
    return await Promise.race([handlerPromise, timeoutPromise, disconnectedPromise])
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)
    return error("TOOL_ERROR", message)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener("abort", abortFromConnection)
  }
}

export const createToolRouter = ({
  kernel,
  registrations,
  defaultDeadlineMs = 60_000,
}: {
  kernel: Kernel
  registrations: Map<string, ToolRegistration>
  defaultDeadlineMs?: number
}) => {
  const list = ({
    caller: requested,
  }: {
    caller: McpCallerContext
  }): Array<{ name: string; description: string; inputSchema: unknown }> => {
    const caller = delegatedCaller(kernel, requested)
    const experimental = isExperimental(kernel)
    const builtIn = toolCatalog.tools
      .filter((tool) => registrations.has(tool.name) && visibleTo({ tool, caller, experimental, kernel }))
      .flatMap<{ name: string; description: string; inputSchema: unknown }>((tool) => {
        if (tool.name !== "capability_request")
          return [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }]
        const bot = kernel.services.use("store.api")?.getBot({ botId: caller.botId })
        const capabilities = bot
          ? (["browser", "computer_use"] as const).filter(
              (capability) => capabilitySupport(kernel, bot, capability) === null,
            )
          : []
        if (!capabilities.length) return []
        return [
          {
            name: tool.name,
            description: tool.description,
            inputSchema: {
              ...tool.inputSchema,
              properties: { ...tool.inputSchema.properties, capability: { enum: capabilities } },
            },
          },
        ]
      })
    return [
      ...builtIn,
      ...attachedTools(kernel, caller.botId, caller.threadId)
        .filter(({ tool }) => tool.policy !== "blocked")
        .map(({ name, server, tool }) => ({
          name,
          description: `${server.name} · ${tool.name}: ${tool.description}`,
          inputSchema: tool.inputSchema ?? { type: "object" },
        })),
    ]
  }

  const call = async ({ id: _id, name, args, caller: requested, signal }: ToolCallParams): Promise<ToolResult> => {
    const caller = delegatedCaller(kernel, requested)
    const startedAt = Date.now()
    const activeRun = kernel.services.use("runtime.activeRun")
    const currentRun = activeRun ? activeRun({ threadId: caller.threadId }) : null
    const runId = currentRun?.id ?? null
    const registration = registrations.get(name)
    const attached = attachedTools(kernel, caller.botId, caller.threadId).find((tool) => tool.name === name)
    let result: ToolResult
    if (attached) {
      result = await withDeadline({
        handler: ({ ctx, args }) => forwardTool({ kernel, ctx, args, ...attached }),
        caller,
        runId,
        args,
        deadlineMs: 30 * 60_000,
        signal,
      })
    } else if (!registration) {
      result = error("TOOL_NOT_FOUND", `Tool ${name} is not registered`)
    } else {
      const definition = toolCatalog.tools.find((tool) => tool.name === name)
      if (!definition || !visibleTo({ tool: definition, caller, experimental: isExperimental(kernel), kernel })) {
        result = error("TOOL_NOT_FOUND", `Tool ${name} is not available`)
      } else {
        const validated = validateToolArgs({ name, args })
        if (!validated.success) result = error(validated.errorCode, validated.error)
        else {
          const gated = requiresPolicyGate({
            name,
            mutates: toolMetadata(definition).mutates === true,
            delegated: !!getDelegation(kernel, caller.threadId),
          })
          const deadlineMs =
            gated || registration.group === "computer"
              ? 30 * 60_000
              : (toolMetadata(definition).deadlineMs ?? defaultDeadlineMs)
          result = await withDeadline({
            handler: async (input) => {
              // approval_prompt is the consent transport itself; gating it would
              // recursively prompt before presenting the provider's request.
              if (!gated || name === "approval_prompt") return registration.handler(input)
              const store = kernel.services.use("store.api")
              const bot = effectiveBot(kernel, caller)
              const consentRequired = CONSENT_REQUIRED_TOOLS.has(name)
              if (!bot || (bot.access === "read-only" && !consentRequired))
                return error("DENIED", "O bot está em modo somente leitura.")
              const destination = approvalDestination(kernel, bot.id)
              const projectStore = createProjectStore({ kernel })
              const definitions = () =>
                registration.group === "process" && caller.projectId
                  ? projectStore
                      .listProcessSpecs({ projectId: caller.projectId })
                      .filter((spec) => (spec.vmBotId ?? null) === (bot.machine === "vm" ? bot.id : null))
                  : []
              const reviewedDefinitions = definitions()
              const reviewedPolicy = JSON.stringify([
                bot.access,
                bot.approvals,
                bot.machine,
                bot.provider,
                bot.projectId,
                bot.browserEnabled,
                bot.computerUse,
                bot.hostComputerUse,
              ])
              const current = () => {
                const latest = effectiveBot(kernel, caller)
                return (
                  !input.ctx.signal.aborted &&
                  !!latest &&
                  JSON.stringify([
                    latest.access,
                    latest.approvals,
                    latest.machine,
                    latest.provider,
                    latest.projectId,
                    latest.browserEnabled,
                    latest.computerUse,
                    latest.hostComputerUse,
                  ]) === reviewedPolicy &&
                  JSON.stringify(definitions()) === JSON.stringify(reviewedDefinitions) &&
                  latest.access === bot.access &&
                  latest.approvals === bot.approvals &&
                  latest.projectId === caller.projectId &&
                  latest.provider === caller.provider &&
                  latest.machine === bot.machine &&
                  store?.getThread({ threadId: caller.threadId })?.botId === bot.id &&
                  approvalDestination(kernel, bot.id) === destination
                )
              }
              if (!current()) return error("DENIED", "A autorização mudou. Solicite a ação novamente.")
              // Computer handlers already present scoped consent for their target.
              const handlesConsent =
                registration.group === "computer" ||
                ["secret_request", "browser_submit_secret", "browser_request_takeover"].includes(name)
              if (
                (bot.approvals === "on-request" || (consentRequired && bot.access === "read-only")) &&
                !handlesConsent
              ) {
                const present = kernel.services.use("approvals.present")
                if (!present) return error("DENIED", "A ponte de aprovação está indisponível.")
                const approved = await present({
                  ctx: input.ctx,
                  scope: { source: "mcp", server: "touri", tool: name },
                  toolName: name,
                  input: redactStructured(
                    reviewedDefinitions.length
                      ? { argumentos: input.args, processos: reviewedDefinitions }
                      : input.args,
                    kernel.redact,
                  ),
                  allowStanding: false,
                  isCurrent: current,
                })
                if (!approved.success || approved.behavior !== "allow")
                  return error("DENIED", "A ação não foi aprovada.")
              }
              if (!current()) return error("DENIED", "A autorização mudou. Solicite a ação novamente.")
              return withDeadline({
                handler: registration.handler,
                caller,
                runId,
                args: input.args,
                deadlineMs:
                  registration.group === "computer"
                    ? 30 * 60_000
                    : (toolMetadata(definition).deadlineMs ?? defaultDeadlineMs),
                signal: input.ctx.signal,
              })
            },
            caller,
            runId,
            args: validated.args,
            deadlineMs,
            signal,
          })
        }
      }
    }
    auditToolCall({
      kernel,
      runId,
      threadId: caller.threadId,
      botId: caller.botId,
      tool: name,
      args,
      result,
      durationMs: Math.max(0, Date.now() - startedAt),
    })
    return result
  }

  return { list, call }
}
