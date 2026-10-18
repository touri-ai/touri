import type { Bot, Kernel, ToolContext, ToolHandler, ToolResult } from "@touri/contracts"
import {
  applyMemoryOperations,
  MEMORY_LIMITS,
  type MemoryOperation,
  type MemoryTarget,
  memoryUsage,
  readEntries,
  writeEntries,
} from "./memory"
import { isReviewThread, readLearningState, writeLearningState } from "./settings"
import { archiveSkill, createSkill, patchSkill, planSkillPatch, type SkillPatch, validateNewSkill } from "./skills"

const fail = (errorCode: string, error: string): ToolResult => ({
  success: false,
  errorCode,
  error,
  content: [{ type: "text", text: `ERROR ${errorCode}: ${error}` }],
})
const ok = (text: string, structured?: unknown): ToolResult => ({
  success: true,
  content: [{ type: "text", text }],
  ...(structured === undefined ? {} : { structured }),
})

/** Memory and skills live in the host bot home; guest and cloud homes are written by their own file tools. */
const writableBot = (kernel: Kernel, ctx: ToolContext): { bot: Bot } | { error: ToolResult } => {
  const bot = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })
  if (!bot) return { error: fail("NOT_FOUND", "Bot não encontrado.") }
  if (bot.access === "read-only") return { error: fail("DENIED", "O bot está em modo somente leitura.") }
  if (bot.machine !== "local")
    return { error: fail("UNSUPPORTED", "O aprendizado contínuo grava a memória só de bots locais nesta versão.") }
  return { bot }
}

/** Changes proposed by an automatic review wait for the user, except new memory facts. */
const approveReview = async ({
  kernel,
  ctx,
  title,
  input,
}: {
  kernel: Kernel
  ctx: ToolContext
  title: string
  input: unknown
}): Promise<boolean> => {
  const present = kernel.services.use("approvals.present")
  if (!present || ctx.signal.aborted) return false
  const result = await present({
    ctx,
    scope: { source: "mcp", server: "touri", tool: "learning_review" },
    toolName: title,
    input,
    allowStanding: false,
    isCurrent: () => !ctx.signal.aborted,
  })
  return result.success && result.behavior === "allow" && !ctx.signal.aborted
}

const resetToolCalls = (kernel: Kernel, botId: string): void => {
  const state = readLearningState(kernel, botId)
  if (state.toolCalls) writeLearningState(kernel, botId, { ...state, toolCalls: 0 })
}

export const createMemoryWriteHandler =
  ({ kernel }: { kernel: Kernel }): ToolHandler =>
  async ({ ctx, args }) => {
    const allowed = writableBot(kernel, ctx)
    if ("error" in allowed) return allowed.error
    const { target, operations } = args as { target: MemoryTarget; operations: MemoryOperation[] }
    const limit = MEMORY_LIMITS[target]
    const apply = () => applyMemoryOperations({ entries: readEntries(allowed.bot.homeDir, target), operations, limit })
    const planned = apply()
    if (!planned.success)
      return {
        ...fail(planned.errorCode, planned.error),
        structured: { entries: planned.entries, usage: memoryUsage(planned.entries, target) },
      }
    if (!planned.changed) return ok("Nada mudou: o fato já está salvo. Não repita.")
    const review = isReviewThread(kernel, ctx.botId, ctx.threadId)
    if (review && operations.some((operation) => operation.action !== "add")) {
      const approved = await approveReview({
        kernel,
        ctx,
        title: target === "user" ? "Aprendizado: alterar USER.md" : "Aprendizado: alterar MEMORY.md",
        input: { arquivo: target === "user" ? "USER.md" : "MEMORY.md", operacoes: operations },
      })
      if (!approved) return fail("DENIED", "A alteração da memória não foi aprovada.")
    }
    // The file may have changed while the card waited; apply to what is there now.
    const result = review ? apply() : planned
    if (!result.success) return fail(result.errorCode, result.error)
    writeEntries(allowed.bot.homeDir, target, result.entries)
    return ok(
      `Memória salva (${memoryUsage(result.entries, target)} caracteres). Esta atualização está concluída; não repita.`,
      { usage: memoryUsage(result.entries, target) },
    )
  }

type SkillAction =
  | { kind: "create"; name: string; description: string; body: string }
  | { kind: "patch"; patch: SkillPatch }
  | { kind: "archive"; name: string }

const skillHandler =
  (kernel: Kernel, action: (args: unknown) => SkillAction): ToolHandler =>
  async ({ ctx, args }) => {
    const allowed = writableBot(kernel, ctx)
    if ("error" in allowed) return allowed.error
    const homeDir = allowed.bot.homeDir
    const request = action(args)
    const review = isReviewThread(kernel, ctx.botId, ctx.threadId)
    const origin = review ? "review" : "chat"
    // Validate first, so the card only ever shows a change that can be applied.
    const invalid =
      request.kind === "create"
        ? validateNewSkill({ homeDir, ...request })
        : request.kind === "patch"
          ? (() => {
              const plan = planSkillPatch({ homeDir, patch: request.patch })
              return plan.success ? null : plan
            })()
          : null
    if (invalid && !invalid.success) return fail(invalid.errorCode, invalid.error)
    if (review) {
      const approved = await approveReview({
        kernel,
        ctx,
        title:
          request.kind === "create"
            ? `Aprendizado: criar a skill ${request.name}`
            : request.kind === "patch"
              ? `Aprendizado: alterar a skill ${request.patch.name}`
              : `Aprendizado: arquivar a skill ${request.name}`,
        input: request.kind === "patch" ? request.patch : request,
      })
      if (!approved) return fail("DENIED", "A alteração da skill não foi aprovada.")
    }
    const result =
      request.kind === "create"
        ? createSkill({ homeDir, ...request, origin, threadId: ctx.threadId })
        : request.kind === "patch"
          ? patchSkill({ homeDir, patch: request.patch, origin, threadId: ctx.threadId })
          : archiveSkill({ homeDir, name: request.name, origin, threadId: ctx.threadId })
    if (!result.success) return fail(result.errorCode, result.error)
    resetToolCalls(kernel, ctx.botId)
    return ok(result.message)
  }

export const createSkillCreateHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  skillHandler(kernel, (args) => {
    const { name, description, body } = args as { name: string; description: string; body: string }
    return { kind: "create", name, description, body }
  })

export const createSkillPatchHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  skillHandler(kernel, (args) => ({ kind: "patch", patch: args as SkillPatch }))

export const createSkillArchiveHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  skillHandler(kernel, (args) => ({ kind: "archive", name: (args as { name: string }).name }))
