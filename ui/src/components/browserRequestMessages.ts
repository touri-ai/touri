import type { Message, Run } from "@touri/contracts"
import { getBrowserActivityTools } from "./browserActivityPresentation"

/** A display projection preserves the stored transcript while keeping handbacks in one card. */
export const getBrowserRequestMessages = (messages: Message[], runs: Run[], focusedMessageId?: string): Message[] => {
  const visible = messages.filter(
    (message) =>
      !(
        message.role === "system" &&
        message.parts.length > 0 &&
        message.parts.every(
          (part) =>
            part.type === "notice" &&
            (part.code === "context_restored" ||
              (part.code === "run_resumed" && part.text === "Retomado após a devolução do navegador")),
        )
      ),
  )
  const requestIds = new Map(runs.map((run) => [run.id, run.browserRequestId ?? run.id]))
  const getRequestId = (message: Message) =>
    message.role === "assistant" && message.runId ? (requestIds.get(message.runId) ?? message.runId) : null
  // Local grouping never changes message objects or their persisted parts.
  const requests = new Map<string, Message[]>()
  visible.forEach((message) => {
    const requestId = getRequestId(message)
    if (requestId) requests.set(requestId, (requests.get(requestId) ?? []).concat(message))
  })

  return visible.flatMap((message) => {
    const requestId = getRequestId(message)
    const history = requestId ? requests.get(requestId) : undefined
    if (!history || history.length < 2 || !history.some((item) => getBrowserActivityTools(item.parts).length > 0))
      return [message]
    const first = history[0]
    const latest = history.at(-1)
    if (!first || !latest || latest.id !== message.id) return []
    const focused = history.find((item) => item.id === focusedMessageId)

    return [
      Object.assign({}, latest, {
        id: focused?.id ?? first.id,
        parentId: focused ? focused.parentId : first.parentId,
        createdAt: first.createdAt,
        parts: history.flatMap((item) => item.parts),
      }),
    ]
  })
}
