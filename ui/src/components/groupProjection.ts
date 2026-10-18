import type { Message, Run } from "@touri/contracts"

export const getGroupBoard = (threadId: string | undefined, messages: Message[], runs: Run[]): Message[] => {
  const turn = runs
    .filter((run) => run.threadId === threadId && !run.groupTurnId)
    .reduce<Run | undefined>((latest, run) => (!latest || run.queuedAt > latest.queuedAt ? run : latest), undefined)
  if (!turn) return []

  return getConfirmedResults(threadId, messages, runs).filter((message) =>
    runs.some((run) => run.id === message.runId && run.groupTurnId === turn.id),
  )
}

export const getGroupMemberState = (botId: string, threadId: string | undefined, messages: Message[], runs: Run[]) => {
  const groupActive = runs.filter(
    (run) => run.groupTurnId && run.threadId === threadId && ["queued", "starting", "running"].includes(run.status),
  )
  const active = groupActive.filter((run) => run.botId === botId)
  const waiting = messages.some(
    (message) =>
      message.threadId === threadId &&
      groupActive.some((run) => run.id === message.runId) &&
      message.parts.some(
        (part) =>
          part.type === "approval" &&
          part.decision === "pending" &&
          (part.groupMemberId ?? message.sender?.id) === botId,
      ),
  )
  const result =
    getConfirmedResults(threadId, messages, runs)
      .filter((message) => message.sender?.id === botId)
      .reduce<Message | undefined>(
        (latest, message) => (!latest || message.createdAt > latest.createdAt ? message : latest),
        undefined,
      )?.text ?? ""
  if (waiting) return { state: "waiting", label: "Aguardando você" as const, result }
  if (active.length) return { state: "working", label: "Trabalhando" as const, result }

  return { state: "idle", label: "Disponível" as const, result }
}

const getConfirmedResults = (threadId: string | undefined, messages: Message[], runs: Run[]) =>
  messages
    .filter(
      (message) =>
        message.threadId === threadId &&
        message.role === "assistant" &&
        message.status === "complete" &&
        message.sender &&
        runs.some(
          (run) =>
            run.id === message.runId &&
            run.groupTurnId &&
            run.status === "succeeded" &&
            run.replyMessageId === message.id,
        ),
    )
    .map((message) => ({
      ...message,
      text: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    }))
