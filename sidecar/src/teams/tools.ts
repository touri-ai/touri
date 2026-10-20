import type { Database } from "bun:sqlite"
import type {
  Bot,
  CreateBotInput,
  Kernel,
  TeamBotDraft,
  TeamCreateInput,
  TeamCreationResult,
  TeamProposalReview,
  TeamProviderStatus,
  ToolContext,
  ToolRegistration,
  ToolResult,
} from "@touri/contracts"
import { hasTeamHiddenCharacters, normalizeBotName, validateToolArgs } from "@touri/contracts"
import { avatarShapeFor } from "@touri/contracts/avatar"
import { createGroupStore } from "../groups/store"
import { getTeamBuilder } from "./eligibility"

const denied = (error: string): ToolResult => ({ success: false, errorCode: "DENIED", error })

export const createTeamTools = (kernel: Kernel): ToolRegistration[] => {
  // This local set prevents overlapping approval waits from creating two teams in one conversation.
  const pending = new Set<string>()
  return [
    {
      name: "team_create",
      group: "core",
      handler: async ({ ctx, args }) => {
        const builder = getTeamBuilder(kernel, ctx)
        if (!builder || builder.run.id !== ctx.runId || ctx.signal.aborted)
          return denied(
            "A proposta exige um Criador de times em conversa direta com a pessoa, fora de rotinas, continuações automáticas e delegações.",
          )
        if (pending.has(ctx.threadId))
          return denied("Já há uma proposta pendente nesta conversa. Resolva o cartão antes de propor outro time.")
        const validated = getValidatedProposal(kernel, args)
        if (!validated.success) return validated
        // Own a copy across the approval await; callers cannot change the reviewed draft.
        const proposal = structuredClone(validated.proposal)
        const reviewed = getBuilderSnapshot(builder.bot)
        const isAdminRun = kernel.services.use("work.isAdminRun")
        const isCurrent = () => {
          const latest = getTeamBuilder(kernel, ctx)
          return (
            !ctx.signal.aborted &&
            latest?.run.id === ctx.runId &&
            getBuilderSnapshot(latest.bot) === reviewed &&
            (!isAdminRun || isAdminRun(ctx.runId ?? ""))
          )
        }
        pending.add(ctx.threadId)
        try {
          const review: TeamProposalReview = { proposal, providers: getProviderStatuses(kernel, proposal) }
          const approval = await kernel.services.use("approvals.present")?.({
            ctx,
            scope: { source: "mcp", server: "touri", tool: "team_create" },
            toolName: "team_create",
            input: { botCount: proposal.bots.length, groupName: proposal.group?.name ?? null },
            teamProposal: review,
            allowStanding: false,
            isCurrent,
          })
          if (!approval?.success || approval.behavior !== "allow" || !approval.approvalId)
            return denied(
              "O time não foi criado: a proposta foi cancelada, expirou ou a execução mudou. Nada foi criado.",
            )
          const responsiblePersonId = kernel.services.use("work.personForRun")?.(builder.run.id)
          const result = await createApprovedTeam(kernel, ctx, proposal, isCurrent, {
            runId: builder.run.id,
            ...(responsiblePersonId ? { responsiblePersonId } : {}),
          })
          try {
            await kernel.services.use("approvals.completeTeam")?.({ approvalId: approval.approvalId, ctx, result })
          } catch {
            kernel.log({
              level: "warn",
              module: "teams",
              msg: "O resultado do time está disponível na resposta da ferramenta.",
            })
          }
          const text = getResultMessage(result)
          return result.status === "created"
            ? { success: true, content: [{ type: "text", text }], structured: result }
            : { success: false, errorCode: "TEAM_CREATION_FAILED", error: text, structured: result }
        } finally {
          pending.delete(ctx.threadId)
        }
      },
    },
  ]
}

const getBuilderSnapshot = (bot: Bot): string =>
  JSON.stringify([
    bot.id,
    bot.teamBuilder,
    bot.name,
    bot.paused,
    bot.archivedAt,
    bot.machine,
    bot.provider,
    bot.access,
    bot.approvals,
    bot.projectId,
    bot.browserEnabled,
    bot.browser,
    bot.computerUse,
    bot.hostComputerUse,
  ])

const getSafeBotInput = (draft: TeamBotDraft): CreateBotInput => ({
  ...draft,
  name: normalizeBotName(draft.name) ?? draft.name,
  access: "workspace-write",
  approvals: "on-request",
  machine: "local",
  projectId: null,
  cwd: null,
  folders: [],
  anyFolderAccess: false,
  browserEnabled: false,
  browser: "touri",
  computerUse: false,
  hostComputerUse: false,
  vmProviderLogin: false,
  providerProfile: null,
  claudeAiConnectors: false,
})

const getValidatedProposal = (
  kernel: Kernel,
  args: unknown,
): { success: true; proposal: TeamCreateInput } | { success: false; errorCode: string; error: string } => {
  const validated = validateToolArgs({ name: "team_create", args })
  if (!validated.success) return validated
  const proposal = args as TeamCreateInput
  const validate = kernel.services.use("bots.validateCreation")
  if (!validate) return { success: false, errorCode: "STORE_ERROR", error: "Criação de bots indisponível." }
  const invalid = proposal.bots.map((draft) => validate(getSafeBotInput(draft))).find((result) => !result.success)
  if (invalid && !invalid.success) return invalid
  const names = proposal.bots.map((bot) => normalizeBotName(bot.name))
  if (new Set(names.map((name) => name?.toLocaleLowerCase())).size !== names.length)
    return { success: false, errorCode: "INVALID_ARGS", error: "Use nomes diferentes para os bots do time." }
  if (
    proposal.bots.some(
      (bot) =>
        hasTeamHiddenCharacters(bot.name) ||
        !bot.roleLine.trim() ||
        hasTeamHiddenCharacters(bot.roleLine) ||
        /[\p{Zl}\p{Zp}]/u.test(bot.roleLine) ||
        !bot.instructions.trim() ||
        hasTeamHiddenCharacters(bot.instructions, true),
    )
  )
    return {
      success: false,
      errorCode: "INVALID_ARGS",
      error: "Informe uma função em uma linha e instruções para cada bot.",
    }
  if (proposal.bots.some((bot) => bot.model != null && hasTeamHiddenCharacters(bot.model)))
    return { success: false, errorCode: "INVALID_ARGS", error: "O modelo contém caracteres ocultos." }
  const group = proposal.group
  if (
    group &&
    (!normalizeBotName(group.name) ||
      hasTeamHiddenCharacters(group.name) ||
      group.members.some((name) => !names.includes(name)) ||
      (group.coordinator !== undefined && !group.members.includes(group.coordinator)))
  )
    return {
      success: false,
      errorCode: "INVALID_ARGS",
      error: "O grupo deve usar apenas os nomes propostos; o coordenador deve ser membro.",
    }
  return { success: true, proposal }
}

const getProviderStatuses = (kernel: Kernel, proposal: TeamCreateInput): TeamProposalReview["providers"] => {
  const checks = kernel.services.use("doctor")?.snapshot().checks ?? []
  return [...new Set(proposal.bots.map((bot) => bot.provider))].map((provider) => {
    const cli = checks.find((check) => check.id === provider)
    const auth = checks.find((check) => check.id === `${provider}-auth`)
    const status: TeamProviderStatus = getProviderReadiness(cli?.ok, auth?.ok)
    return { provider, status }
  })
}

const getProviderReadiness = (cli: boolean | undefined, auth: boolean | undefined): TeamProviderStatus => {
  if (cli === undefined || auth === undefined) return "unknown"
  if (cli && auth) return "ready"
  return "needs-setup"
}

const createApprovedTeam = async (
  kernel: Kernel,
  ctx: ToolContext,
  proposal: TeamCreateInput,
  isCurrent: () => boolean,
  identity: { runId: string; responsiblePersonId?: string },
): Promise<TeamCreationResult> => {
  const created: TeamCreationResult["bots"] = []
  try {
    // Revalidate the whole proposal after consent (for example an API model may have been removed).
    const valid = getValidatedProposal(kernel, proposal)
    if (!valid.success || !isCurrent()) throw new Error("Proposal changed")
    for (const draft of proposal.bots) {
      if (!isCurrent()) throw new Error("Run changed")
      const result = await kernel.services.use("bots.create")?.({
        body: getSafeBotInput(draft),
        signal: ctx.signal,
        isCurrent,
        runId: identity.runId,
        ...(identity.responsiblePersonId ? { responsiblePersonId: identity.responsiblePersonId } : {}),
      })
      if (!result?.success) throw new Error("Bot creation failed")
      // This bounded local ledger reports committed bots even if a later creation fails.
      created.push({ id: result.bot.id, name: result.bot.name, threadId: result.bot.mainThreadId })
    }
    if (!proposal.group) return { status: "created", bots: created }
    if (!isCurrent()) throw new Error("Run changed")
    const groupStore = createGroupStore(kernel)
    const avatarSeed = kernel.newId()
    const input = {
      name: proposal.group.name,
      memberIds: proposal.group.members.map((name) => created.find((bot) => bot.name === name)?.id ?? ""),
      coordinatorBotId: created.find((bot) => bot.name === proposal.group?.coordinator)?.id ?? null,
      color: "#5C7CFA",
      avatarShape: avatarShapeFor(avatarSeed),
    }
    if (!groupStore.validate(input)) throw new Error("Invalid group")
    const result = (kernel.db as Database).transaction(() => {
      const group = groupStore.save(input)
      return { group, thread: groupStore.createThread(group) }
    })()
    try {
      kernel.publish({ type: "group.updated", group: result.group })
    } catch {
      kernel.log({ level: "warn", module: "teams", msg: "Grupo criado; atualize a lista para vê-lo." })
    }
    return {
      status: "created",
      bots: created,
      group: { id: result.group.id, name: result.group.name, threadId: result.thread.id },
    }
  } catch {
    return { status: created.length ? "partial" : "failed", bots: created, error: "creation-failed" }
  }
}

const getResultMessage = (result: TeamCreationResult): string => {
  if (result.status === "created")
    return "Time criado após sua aprovação. Os links estão no cartão. Instalação ou login pendentes podem ser resolvidos nas configurações de cada bot."
  if (!result.bots.length) return "Não foi possível criar o time. Nenhum bot ou grupo foi criado. Tente novamente."
  return `A criação parou. Bots criados: ${result.bots.map((bot) => bot.name).join(", ")}. O grupo não foi criado. Os links estão no cartão; você pode manter ou apagar esses bots antes de tentar novamente.`
}
