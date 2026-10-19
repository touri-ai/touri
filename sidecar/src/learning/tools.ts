import type { Bot, Kernel, ToolContext, ToolHandler, ToolResult } from "@touri/contracts"
import { hiddenInGroupSession } from "../groups/privacy"
import { getDelegation } from "../groups/security"
import {
  applyMemoryOperations,
  MEMORY_LIMITS,
  type MemoryOperation,
  type MemoryTarget,
  memoryUsage,
  readEntries,
  writeEntries,
} from "./memory"
import { isReviewThread, learningToolHidden, readLearningState, writeLearningState } from "./settings"
import {
  archiveSkill,
  createSkill,
  patchSkill,
  planSkillArchive,
  planSkillPatch,
  type SkillPatch,
  validateNewSkill,
} from "./skills"

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

const fileGuard =
  (handler: ToolHandler): ToolHandler =>
  async (input) => {
    try {
      return await handler(input)
    } catch (error) {
      return error instanceof Error && error.message === "INVALID_PATH"
        ? fail("INVALID_PATH", "O caminho da memória não é permitido.")
        : fail(
            "WRITE_FAILED",
            "Não foi possível acessar os arquivos de aprendizado. Verifique as permissões e tente novamente.",
          )
    }
  }

/** Local, enabled, private and writable at the moment the change is applied. */
const writableBot = (kernel: Kernel, ctx: ToolContext, toolName: string): { bot: Bot } | { error: ToolResult } => {
  const bot = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })
  if (!bot) return { error: fail("NOT_FOUND", "Bot não encontrado.") }
  if (bot.machine !== "local")
    return { error: fail("UNSUPPORTED", "O aprendizado contínuo grava a memória só de bots locais nesta versão.") }
  if (
    ctx.signal.aborted ||
    bot.access === "read-only" ||
    bot.paused ||
    bot.archivedAt ||
    learningToolHidden(kernel, bot.id, toolName) ||
    hiddenInGroupSession(kernel, ctx.threadId, toolName) ||
    getDelegation(kernel, ctx.threadId)
  )
    return {
      error: fail("DENIED", "O aprendizado está desativado ou a autorização mudou. Verifique as configurações do bot."),
    }
  return { bot }
}

const authorizationCurrent = (kernel: Kernel, ctx: ToolContext, bot: Bot, toolName: string): boolean => {
  const latest = writableBot(kernel, ctx, toolName)
  return (
    "bot" in latest &&
    latest.bot.access === bot.access &&
    latest.bot.approvals === bot.approvals &&
    latest.bot.homeDir === bot.homeDir
  )
}

/** Automatic edits require consent bound to the current permissions. */
const approveReview = async ({
  kernel,
  ctx,
  title,
  input,
  isCurrent,
}: {
  kernel: Kernel
  ctx: ToolContext
  title: string
  input: unknown
  isCurrent: () => boolean
}): Promise<boolean> => {
  const canApply = (): boolean => {
    try {
      return isCurrent()
    } catch {
      return false
    }
  }
  const present = kernel.services.use("approvals.present")
  if (!present || !canApply()) return false
  const result = await present({
    ctx,
    scope: { source: "mcp", server: "touri", tool: "learning_review" },
    toolName: title,
    input,
    allowStanding: false,
    isCurrent: canApply,
  })
  return result.success && result.behavior === "allow" && canApply()
}

const resetToolCalls = (kernel: Kernel, botId: string): void => {
  const state = readLearningState(kernel, botId)
  if (state.toolCalls) writeLearningState(kernel, botId, { ...state, toolCalls: 0 })
}

export const createMemoryWriteHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  fileGuard(async ({ ctx, args }) => {
    const allowed = writableBot(kernel, ctx, "memory_write")
    if ("error" in allowed) return allowed.error
    const { target, operations } = args as { target: MemoryTarget; operations: MemoryOperation[] }
    const entries = readEntries(allowed.bot.homeDir, target)
    const planned = applyMemoryOperations({ entries, operations, limit: MEMORY_LIMITS[target] })
    if (!planned.success)
      return {
        ...fail(planned.errorCode, planned.error),
        structured: { entries: planned.entries, usage: memoryUsage(planned.entries, target) },
      }
    if (!planned.changed) return ok("Nada mudou: o fato já está salvo. Não repita.")
    const review = isReviewThread(kernel, ctx.botId, ctx.threadId)
    const current = () =>
      authorizationCurrent(kernel, ctx, allowed.bot, "memory_write") &&
      JSON.stringify(readEntries(allowed.bot.homeDir, target)) === JSON.stringify(entries)
    if (review && operations.some((operation) => operation.action !== "add")) {
      const approved = await approveReview({
        kernel,
        ctx,
        isCurrent: current,
        title: target === "user" ? "Aprendizado: alterar USER.md" : "Aprendizado: alterar MEMORY.md",
        input: {
          arquivo: target === "user" ? "USER.md" : "MEMORY.md",
          operacoes: operations,
          antes: entries,
          depois: planned.entries,
        },
      })
      if (!approved) return fail("DENIED", "A alteração da memória não foi aprovada ou a autorização mudou.")
    }
    if (!current()) return fail("DENIED", "A memória ou a autorização mudou. Solicite a alteração novamente.")
    await writeEntries(allowed.bot.homeDir, target, planned.entries)
    return ok(
      `Memória salva (${memoryUsage(planned.entries, target)} caracteres). Esta atualização está concluída; não repita.`,
      { usage: memoryUsage(planned.entries, target) },
    )
  })

type SkillAction =
  | { kind: "create"; name: string; description: string; body: string }
  | { kind: "patch"; patch: SkillPatch }
  | { kind: "archive"; name: string }

const skillHandler = (kernel: Kernel, action: (args: unknown) => SkillAction): ToolHandler =>
  fileGuard(async ({ ctx, args }) => {
    const allowed = writableBot(kernel, ctx, "skill_create")
    if ("error" in allowed) return allowed.error
    const homeDir = allowed.bot.homeDir
    const request = action(args)
    const review = isReviewThread(kernel, ctx.botId, ctx.threadId)
    const origin = review ? "review" : "chat"
    const plan = () =>
      request.kind === "create"
        ? validateNewSkill({ homeDir, ...request })
        : request.kind === "patch"
          ? planSkillPatch({ homeDir, patch: request.patch })
          : planSkillArchive({ homeDir, name: request.name })
    const planned = plan()
    if (planned && !planned.success) return fail(planned.errorCode, planned.error)
    const current = () =>
      authorizationCurrent(kernel, ctx, allowed.bot, "skill_create") &&
      JSON.stringify(plan()) === JSON.stringify(planned)
    if (review) {
      const approved = await approveReview({
        kernel,
        ctx,
        isCurrent: current,
        title:
          request.kind === "create"
            ? `Aprendizado: criar a skill ${request.name}`
            : request.kind === "patch"
              ? `Aprendizado: alterar a skill ${request.patch.name}`
              : `Aprendizado: arquivar a skill ${request.name}`,
        input: request.kind === "patch" ? request.patch : request,
      })
      if (!approved) return fail("DENIED", "A alteração da skill não foi aprovada ou a autorização mudou.")
    }
    if (!current()) return fail("DENIED", "A skill ou a autorização mudou. Solicite a alteração novamente.")
    const result =
      request.kind === "create"
        ? await createSkill({ homeDir, ...request, origin, threadId: ctx.threadId })
        : request.kind === "patch"
          ? await patchSkill({ homeDir, patch: request.patch, origin, threadId: ctx.threadId })
          : await archiveSkill({ homeDir, name: request.name, origin, threadId: ctx.threadId })
    if (!result.success) return fail(result.errorCode, result.error)
    resetToolCalls(kernel, ctx.botId)
    return ok(result.message)
  })

export const createSkillCreateHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  skillHandler(kernel, (args) => {
    const { name, description, body } = args as { name: string; description: string; body: string }
    return { kind: "create", name, description, body }
  })
export const createSkillPatchHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  skillHandler(kernel, (args) => ({ kind: "patch", patch: args as SkillPatch }))
export const createSkillArchiveHandler = ({ kernel }: { kernel: Kernel }): ToolHandler =>
  skillHandler(kernel, (args) => ({ kind: "archive", name: (args as { name: string }).name }))
