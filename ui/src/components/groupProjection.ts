import type { Message, Run } from "@touri/contracts"

export type GroupMemberState = {
  state: "idle" | "working" | "waiting" | "failed"
  label: "Disponível" | "Trabalhando" | "Aguardando você" | "Falhou"
  result: string
}

export const getGroupProjection = (threadId: string | undefined, messages: Message[], runs: Run[]) => {
  const threadRuns = runs.filter((run) => run.threadId === threadId)
  const runsById = new Map(threadRuns.map((run) => [run.id, run]))
  const turn = threadRuns
    .filter((run) => !run.groupTurnId)
    .reduce<Run | undefined>((latest, run) => (!latest || run.queuedAt > latest.queuedAt ? run : latest), undefined)
  const memberRuns = threadRuns.filter((run) => run.groupTurnId)
  const active = memberRuns.filter((run) => ["queued", "starting", "running"].includes(run.status))
  const activeIds = new Set(active.map((run) => run.id))
  const working = new Set(active.map((run) => run.botId))
  const failed = new Set(
    getLatestRunsByMember(memberRuns.filter((run) => run.groupTurnId === turn?.id))
      .filter((run) => ["failed", "interrupted", "canceled"].includes(run.status))
      .map((run) => run.botId),
  )
  const confirmed = getConfirmedResults(threadId, messages, runsById)
  const resultsByMember = getLatestResultsByMember(confirmed)
  const waiting = new Set(
    messages.flatMap((message) => {
      if (message.threadId !== threadId || !message.runId || !activeIds.has(message.runId)) return []

      return message.parts.flatMap((part) =>
        part.type === "approval" && part.decision === "pending" ? [part.groupMemberId ?? message.sender?.id] : [],
      )
    }),
  )
  const memberIds = new Set(memberRuns.map((run) => run.botId).concat([...waiting].filter((id) => id !== undefined)))
  const members = new Map(
    [...memberIds].map((botId) => [
      botId,
      getMemberState(working.has(botId), waiting.has(botId), failed.has(botId), resultsByMember.get(botId)?.text ?? ""),
    ]),
  )
  const board = turn ? confirmed.filter((message) => runsById.get(message.runId ?? "")?.groupTurnId === turn.id) : []
  const removed = turn
    ? messages.filter(
        (message) =>
          message.threadId === threadId &&
          message.runId === turn.id &&
          message.role === "system" &&
          message.parts.some((part) => part.type === "notice" && part.code === "group_member_removed"),
      )
    : []

  return { board, members, removed }
}

/** Coordination is a placeholder until an execution attaches, never a second provider task. */
export const getGroupProgress = (threadId: string | undefined, runs: Run[]) => {
  const threadRuns = runs.filter((run) => run.threadId === threadId)
  const attachedTurns = new Set(threadRuns.flatMap((run) => (run.groupTurnId ? [run.groupTurnId] : [])))
  const active = threadRuns.filter((run) => ["queued", "starting", "running"].includes(run.status))
  const executions = active.filter((run) => run.kind !== "coordination")
  const progress = active.filter((run) => run.kind !== "coordination" || !attachedTurns.has(run.id))
  const control = active.find((run) => run.kind === "coordination") ?? active[0] ?? null

  return { progress, executions, control }
}

export const getGroupBoard = (threadId: string | undefined, messages: Message[], runs: Run[]) =>
  getGroupProjection(threadId, messages, runs).board

export const getGroupMemberState = (botId: string, threadId: string | undefined, messages: Message[], runs: Run[]) =>
  getGroupProjection(threadId, messages, runs).members.get(botId) ?? getIdleMemberState()

export const getIdleMemberState = (): GroupMemberState => ({ state: "idle", label: "Disponível", result: "" })

const getMemberState = (working: boolean, waiting: boolean, failed: boolean, result: string): GroupMemberState => {
  if (waiting) return { state: "waiting", label: "Aguardando você", result }
  if (working) return { state: "working", label: "Trabalhando", result }
  if (failed) return { state: "failed", label: "Falhou", result }

  return { state: "idle", label: "Disponível", result }
}

const getLatestResultsByMember = (messages: Message[]) => {
  // A local index keeps streaming updates linear in the conversation size.
  const results = new Map<string, Message>()
  messages.forEach((message) => {
    if (!message.sender) return
    const previous = results.get(message.sender.id)
    if (previous && previous.createdAt >= message.createdAt) return

    results.set(message.sender.id, message)
  })

  return results
}

const getLatestRunsByMember = (runs: Run[]): Run[] => {
  // A local index avoids rescanning the run history for each member.
  const latest = new Map<string, Run>()
  runs.forEach((run) => {
    const previous = latest.get(run.botId)
    if (previous && previous.queuedAt >= run.queuedAt) return

    latest.set(run.botId, run)
  })

  return [...latest.values()]
}

const getConfirmedResults = (threadId: string | undefined, messages: Message[], runsById: Map<string, Run>) =>
  messages
    .filter((message) => {
      if (message.threadId !== threadId || message.role !== "assistant" || message.status !== "complete") return false
      if (!message.sender || !message.runId) return false
      const run = runsById.get(message.runId)

      return run?.groupTurnId && run.status === "succeeded" && run.replyMessageId === message.id
    })
    .map((message) => ({
      ...message,
      text: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    }))
