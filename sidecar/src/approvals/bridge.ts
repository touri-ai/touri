import type { Database } from "bun:sqlite"
import { isDeepStrictEqual } from "node:util"
import type { ApprovalInput, ApprovalPart, ApprovalResult, Kernel, ServiceMap } from "@touri/contracts"
import { redactStructured } from "../kernel/redact"
import { createRuntimeNotices } from "../runtime/notices"
import { asRecord, stringValue } from "../runtime/utils"
import { bindApprovalScope, createStandingGrantStore, sameScope } from "./grants"
import { approvalOutcome } from "./outcome"
import { claudeApprovalKind, claudeApprovalPayload } from "./payload"

export const createApprovalBridge = ({
  kernel,
  onCard,
  timeoutMs = 30 * 60_000,
}: {
  kernel: Kernel
  onCard: (ctx: ApprovalInput["ctx"], part: ApprovalPart) => boolean | Promise<boolean>
  timeoutMs?: number
}) => {
  const grants = createStandingGrantStore(kernel)
  const notices = createRuntimeNotices({ kernel })
  let disposed = false
  // These local registries hold approval ownership and the result card across asynchronous creation.
  const pendingTeamThreads = new Set<string>()
  const approvedTeams = new Map<string, { input: ApprovalInput; part: ApprovalPart }>()
  const outcomes: Array<{ input: ApprovalInput; message: string }> = []
  const remember = (input: ApprovalInput, message: string) => {
    if (input.scope.source === "claude" && input.ctx.runId) outcomes.push({ input, message })
  }
  const pending = new Map<
    string,
    { input: ApprovalInput; part: ApprovalPart; resolve: (result: ApprovalResult) => void; cleanup: () => void }
  >()

  const publishCard = async (input: ApprovalInput, part: ApprovalPart): Promise<boolean> => {
    try {
      return await onCard(input.ctx, structuredClone(part))
    } catch {
      kernel.log({ level: "warn", module: "approvals", msg: "Não foi possível atualizar o cartão de aprovação." })
      return false
    }
  }
  const isCurrent = (input: ApprovalInput): boolean => {
    const store = kernel.services.use("store.api")
    return (
      !disposed &&
      !input.ctx.signal.aborted &&
      store?.getThread({ threadId: input.ctx.threadId })?.botId === input.ctx.botId &&
      !!store.getBot({ botId: input.ctx.botId }) &&
      sameScope(input.scope, bindApprovalScope(kernel, input.ctx.botId, input.scope)) &&
      input.isCurrent?.() !== false
    )
  }
  const finish = async (
    id: string,
    decision: ApprovalPart["decision"],
    message?: string,
    answered = false,
    standing = false,
  ): Promise<void> => {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (request.part.teamProposal) pendingTeamThreads.delete(request.input.ctx.threadId)
    request.cleanup()
    request.part.decision = decision
    request.part.resolvedAt = Date.now()
    request.part.standing = decision === "approved" && standing
    const saved = await publishCard(request.input, request.part)
    const resolvedDecision = saved ? decision : "denied"
    if (resolvedDecision === "approved" && request.part.teamProposal) approvedTeams.set(id, request)
    notices.resolve({
      requestId: id,
      resolution:
        resolvedDecision === "approved"
          ? "allow"
          : resolvedDecision === "expired"
            ? "expired"
            : answered
              ? "answer"
              : "deny",
    })
    const outcome =
      resolvedDecision === "approved"
        ? standing
          ? approvalOutcome.standing
          : approvalOutcome.once
        : saved
          ? (message ?? approvalOutcome.denied)
          : "A aprovação não pôde ser salva."
    if (resolvedDecision !== "expired" && saved) remember(request.input, outcome)
    request.resolve(
      resolvedDecision === "expired"
        ? { success: false, errorCode: "TIMEOUT", error: "A aprovação expirou." }
        : resolvedDecision === "approved"
          ? { success: true, behavior: "allow", approvalId: id, updatedInput: request.input.input, message: outcome }
          : { success: true, behavior: "deny", message: outcome },
    )
  }

  const present: ServiceMap["approvals.present"] = async (request) => {
    const input = { ...request, scope: bindApprovalScope(kernel, request.ctx.botId, request.scope) }
    if (disposed || input.ctx.signal.aborted)
      return { success: false, errorCode: "DENIED", error: "A ação foi cancelada." }
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId: input.ctx.threadId })
    if (!thread || thread.botId !== input.ctx.botId || !store?.getBot({ botId: input.ctx.botId }))
      return { success: false, errorCode: "NOT_FOUND", error: "Bot ou conversa indisponível." }
    if (!isCurrent(input))
      return { success: false, errorCode: "DENIED", error: "A autorização mudou. Solicite a ação novamente." }
    const teamReview = input.scope.server === "touri" && input.toolName === "team_create"
    if (teamReview && (!input.teamProposal || pendingTeamThreads.has(input.ctx.threadId)))
      return { success: false, errorCode: "DENIED", error: "Proposta de time indisponível ou já pendente." }
    const teamProposal = teamReview ? redactStructured(input.teamProposal, kernel.redact) : undefined
    if (teamReview && !isDeepStrictEqual(input.teamProposal, teamProposal))
      return {
        success: false,
        errorCode: "DENIED",
        error: "A proposta contém texto que seria ocultado no cartão. Remova esse conteúdo e tente novamente.",
      }
    const allowStanding = !teamReview && input.allowStanding !== false && input.toolName !== "AskUserQuestion"
    if (allowStanding && grants.has(input.ctx.botId, input.scope)) {
      remember(input, approvalOutcome.automatic)
      return { success: true, behavior: "allow", updatedInput: input.input, message: approvalOutcome.automatic }
    }
    const routineReview = input.scope.server === "touri" && input.toolName === "routine_create"
    const fields = input.input as Record<string, unknown> | null
    // The gateway's creation approval also carries the original prompt. Keep the
    // full input for execution; only the review sent to the UI needs a preview.
    const { prompt, ...metadata } = routineReview && fields && typeof fields === "object" ? fields : {}
    const reviewInput =
      routineReview && typeof prompt === "string"
        ? {
            ...metadata,
            promptPreview: prompt.length > 512 ? `${prompt.slice(0, 512)}…` : prompt,
            promptLength: prompt.length,
          }
        : input.input
    const nativeReview = input.scope.source === "claude"
    const payload = nativeReview
      ? claudeApprovalPayload(reviewInput, stringValue(asRecord(input.ctx)?.cwd) ?? undefined)
      : reviewInput
    const detail = `${input.toolName}: ${JSON.stringify(redactStructured(payload, kernel.redact))}`
    // Never offer routine activation with a truncated review, even for unusually
    // large schedule metadata. The routine stays paused when delivery is refused.
    if (routineReview && detail.length > 8000)
      return { success: false, errorCode: "DENIED", error: "Os detalhes da rotina excedem o limite de revisão." }
    const approvalId = kernel.newId()
    const part: ApprovalPart = {
      ...(teamReview
        ? {
            teamProposal: teamProposal as NonNullable<ApprovalPart["teamProposal"]>,
          }
        : {}),
      type: "approval",
      createdAt: Date.now(),
      approvalId,
      botId: input.ctx.botId,
      ...(input.groupMemberId ? { groupMemberId: input.groupMemberId } : {}),
      request: nativeReview ? claudeApprovalKind(input.toolName) : "permission",
      scope: input.scope,
      allowStanding,
      detail: nativeReview ? detail : detail.slice(0, 8000),
      decision: "pending",
    }
    return new Promise((resolve) => {
      const onAbort = () => void finish(approvalId, "denied", "A ação foi cancelada.")
      const timer = setTimeout(() => void finish(approvalId, "expired"), timeoutMs)
      if (teamReview) pendingTeamThreads.add(input.ctx.threadId)
      pending.set(approvalId, {
        input,
        part,
        resolve,
        cleanup: () => {
          clearTimeout(timer)
          input.ctx.signal.removeEventListener("abort", onAbort)
        },
      })
      input.ctx.signal.addEventListener("abort", onAbort, { once: true })
      if (input.ctx.signal.aborted) return onAbort()
      void publishCard(input, part).then((saved) => {
        if (!saved) {
          void finish(approvalId, "denied", "Execução indisponível.")
          return
        }
        if (!pending.has(approvalId)) return
        notices.prompt({
          botId: input.ctx.botId,
          threadId: input.ctx.threadId,
          requestId: approvalId,
          toolName: input.toolName,
          input: input.input,
          detail: part.detail,
          scope: part.scope,
        })
      })
    })
  }
  const approve: ServiceMap["approvals.approve"] = async ({ approvalId, decision, standing, message }) => {
    const request = pending.get(approvalId)
    if (!request) return { success: false, errorCode: "NOT_FOUND", error: "Aprovação não encontrada." }
    if (!isCurrent(request.input)) {
      await finish(approvalId, "denied", "A ação foi cancelada ou a autorização mudou.")
      return { success: false, errorCode: "NOT_FOUND", error: "A ação foi cancelada ou a autorização mudou." }
    }
    if (decision === "approved" && standing && request.part.allowStanding)
      grants.add(request.input.ctx.botId, request.input.scope)
    await finish(approvalId, decision, message, !!message, !!standing && !!request.part.allowStanding)
    return { success: true }
  }
  const completeTeam: ServiceMap["approvals.completeTeam"] = async ({ approvalId, ctx, result }) => {
    const approved = approvedTeams.get(approvalId)
    if (
      !approved ||
      approved.input.ctx.botId !== ctx.botId ||
      approved.input.ctx.threadId !== ctx.threadId ||
      approved.input.ctx.runId !== ctx.runId
    )
      return
    approvedTeams.delete(approvalId)
    const part = { ...approved.part, teamResult: result }
    if (await publishCard(approved.input, part)) return
    // A stop can finish the run during file creation. Persist the committed ledger on its card anyway.
    const row = (kernel.db as Database)
      .query("SELECT reply_message_id FROM runs WHERE id = ? AND thread_id = ?")
      .get(ctx.runId, ctx.threadId) as { reply_message_id: string | null } | null
    const store = kernel.services.use("store.api")
    const message = row?.reply_message_id
      ? store?.getPathMessage?.({ threadId: ctx.threadId, messageId: row.reply_message_id })
      : null
    if (!message?.parts.some((item) => item.type === "approval" && item.approvalId === approvalId)) return
    if (!store) return
    const update = store.updateMessageAsync ?? store.updateMessage
    await update({
      threadId: ctx.threadId,
      messageId: message.id,
      patch: {
        parts: message.parts.map((item) => (item.type === "approval" && item.approvalId === approvalId ? part : item)),
      },
    })
  }
  const settle: ServiceMap["approvals.settle"] = ({ approvalId, decision }) => {
    void finish(approvalId, decision)
  }
  const dispose = () => {
    disposed = true
    for (const id of pending.keys()) void finish(id, "denied", "A execução terminou.")
    pendingTeamThreads.clear()
    approvedTeams.clear()
    outcomes.length = 0
  }
  const cancelRun = (runId: string) => {
    for (const [id, request] of pending)
      if (request.input.ctx.runId === runId) void finish(id, "denied", "A execução terminou.")
    for (let index = outcomes.length - 1; index >= 0; index--)
      if (outcomes[index]?.input.ctx.runId === runId) outcomes.splice(index, 1)
  }
  const context = (input: Pick<ApprovalInput, "ctx" | "toolName" | "toolUseId" | "input">): string | null => {
    if (disposed || input.ctx.signal.aborted || !input.ctx.runId) return null
    const index = outcomes.findIndex(
      ({ input: saved }) =>
        saved.ctx.botId === input.ctx.botId &&
        saved.ctx.threadId === input.ctx.threadId &&
        saved.ctx.runId === input.ctx.runId &&
        saved.toolName === input.toolName &&
        (saved.toolUseId ? saved.toolUseId === input.toolUseId : isDeepStrictEqual(saved.input, input.input)),
    )
    return index < 0 ? null : (outcomes.splice(index, 1)[0]?.message ?? null)
  }
  return { present, approve, settle, dispose, cancelRun, context, completeTeam }
}
