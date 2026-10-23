import type { Message, Run } from "@touri/contracts"

/** Hide only a coordination echo linked to an earlier stopped execution with content. */
export const getChannelMessages = (messages: readonly Message[], runs: readonly Run[]): Message[] => {
  const runsById = new Map(runs.map((run) => [run.id, run]))
  // Local indexes keep render work linear instead of rescanning growing history for every echo.
  const stoppedAuthors = new Set<string>()
  const stoppedTurns = new Set<string>()

  return messages.filter((message) => {
    if (message.role !== "assistant" || message.status !== "canceled") return true
    const run = runsById.get(message.runId ?? "")
    if (!run) return true

    if (run.kind === "execution" && run.groupTurnId && hasContent(message)) {
      stoppedTurns.add(getKey(message.threadId, run.groupTurnId))
      stoppedAuthors.add(getKey(message.threadId, run.groupTurnId, message.sender?.id ?? run.botId))
      return true
    }
    if (run.kind !== "coordination" || !isEmptyCancelReply(message)) return true

    const key = getKey(message.threadId, run.id, message.sender?.id)
    return message.sender === null ? !stoppedTurns.has(key) : !stoppedAuthors.has(key)
  })
}

const getKey = (threadId: string, turnId: string, authorId?: string): string =>
  JSON.stringify([threadId, turnId, authorId ?? null])

const isCancelNotice = (part: Message["parts"][number]): boolean =>
  part.type === "notice" && part.code === "run_canceled"

const isEmptyCancelReply = (message: Message): boolean =>
  message.text.trim() === "" && message.parts.length > 0 && message.parts.every(isCancelNotice)

const hasContent = (message: Message): boolean =>
  message.text.trim() !== "" ||
  message.parts.some((part) => !isCancelNotice(part) && (part.type !== "text" || part.text.trim() !== ""))
