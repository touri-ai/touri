import type { Bot, CapabilityRequestInput, Kernel, ToolContext, ToolRegistration, ToolResult } from "@touri/contracts"
import { getDelegation } from "../groups/security"
import { capabilitySupport } from "./capability-support"

const denied = (error: string): ToolResult => ({ success: false, errorCode: "DENIED", error })
const snapshot = (bot: Bot) =>
  JSON.stringify([
    bot.name,
    bot.machine,
    bot.provider,
    bot.browserEnabled,
    bot.browser,
    bot.computerUse,
    bot.hostComputerUse,
    bot.access,
    bot.approvals,
    bot.paused,
  ])

export const createCapabilityTools = (
  kernel: Kernel,
  support: typeof capabilitySupport = capabilitySupport,
): Array<ToolRegistration & { group: "project" }> => {
  const self = (ctx: ToolContext) => {
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId: ctx.threadId })
    const run = kernel.services.use("runtime.activeRun")?.({ threadId: ctx.threadId })
    if (
      ctx.signal.aborted ||
      getDelegation(kernel, ctx.threadId) ||
      !run ||
      run.id !== ctx.runId ||
      run.botId !== ctx.botId ||
      !["starting", "running"].includes(run.status) ||
      !["user", "retry"].includes(run.trigger) ||
      run.routineRunId ||
      thread?.routineRunId ||
      thread?.groupId ||
      thread?.botId !== ctx.botId
    )
      return null
    const bot = store?.getBot({ botId: ctx.botId })
    return bot && !bot.paused ? bot : null
  }
  return [
    {
      name: "capability_request",
      group: "project",
      handler: async ({ ctx, args }) => {
        const bot = self(ctx)
        if (!bot)
          return denied(
            "Este acesso só pode ser solicitado pelo próprio bot em uma conversa com a pessoa, fora de rotinas e delegações.",
          )
        const { capability, reason } = args as CapabilityRequestInput
        if (
          !["browser", "computer_use"].includes(capability) ||
          typeof reason !== "string" ||
          !reason.trim() ||
          reason.length > 240 ||
          /[\p{Cc}\p{Zl}\p{Zp}]/u.test(reason)
        )
          return {
            success: false,
            errorCode: "INVALID_ARGS",
            error: "Informe o recurso e um motivo curto, sem quebras de linha.",
          }
        const unsupported = support(kernel, bot, capability)
        if (unsupported) return { success: false, errorCode: "UNSUPPORTED", error: unsupported }
        const field = capability === "browser" ? "browserEnabled" : "computerUse"
        if (bot[field])
          return {
            success: true,
            content: [{ type: "text", text: "Este recurso já está ativado neste bot." }],
            structured: { capability, enabled: true, automaticContinuation: false },
          }
        const reviewed = snapshot(bot)
        const isCurrent = () => {
          const latest = self(ctx)
          return !!latest && snapshot(latest) === reviewed && support(kernel, latest, capability) === null
        }
        const approval = await kernel.services.use("approvals.present")?.({
          ctx,
          scope: { source: "mcp", server: "touri", tool: "capability_request" },
          toolName: "capability_request",
          input: {
            capability,
            reason: reason.trim(),
            botName: bot.name,
            machine: bot.machine,
            hostComputerUse: bot.hostComputerUse,
          },
          allowStanding: false,
          isCurrent,
        })
        if (!approval?.success || approval.behavior !== "allow" || !isCurrent())
          return denied(
            "O acesso não foi ativado. Se quiser ativar depois, abra as configurações deste bot e ative o navegador ou o controle do computador. Respeite a decisão e não solicite novamente.",
          )
        const configure = kernel.services.use("bots.configureAccess")
        if (!configure) return denied("A configuração do bot está indisponível.")
        const result = await configure({
          botId: bot.id,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          patch:
            capability === "browser"
              ? { browserEnabled: true, browser: bot.machine === "vm" ? "machine" : "touri" }
              : { computerUse: true },
        })
        if (!result.success) return result
        const automaticContinuation = kernel.services.use("runtime.continueAfterApproval")?.(ctx) === true
        const message = automaticContinuation
          ? "Acesso ativado neste bot. Encerre sua resposta agora, sem falar em turnos nem em retomada: o touri retoma a tarefa sozinho com a configuração aprovada e avisa o usuário."
          : "Acesso ativado neste bot. Vale a partir da próxima mensagem."
        return {
          success: true,
          content: [{ type: "text", text: message }],
          structured: {
            capability,
            enabled: result.bot[field],
            effective: "next-turn",
            automaticContinuation,
            message,
          },
        }
      },
    },
  ]
}
