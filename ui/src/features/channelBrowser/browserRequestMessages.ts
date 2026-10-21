import type { Message } from "@touri/contracts"

export const getBrowserRequestMessages = (messages: readonly Message[], fallbackBotId?: string): Message[] => {
  // Local indexes keep grouping linear and preserve each request's original position in the transcript.
  const requests = new Map<string, Message[]>()
  const keys = new Map<string, string>()
  messages.forEach((message) => {
    if (message.role !== "assistant") return
    const requestId = message.parts.find((part) => part.type === "tool_call" && part.browserRequestId)
    const botId = message.sender?.id ?? fallbackBotId
    if (requestId?.type !== "tool_call" || !requestId.browserRequestId || !botId) return

    const key = JSON.stringify([message.threadId, botId, requestId.browserRequestId])
    keys.set(message.id, key)
    requests.set(key, (requests.get(key) ?? []).concat(message))
  })

  return messages.flatMap((message) => {
    const key = keys.get(message.id)
    const entries = key ? requests.get(key) : undefined
    const first = entries?.[0]
    const latest = entries?.at(-1)
    if (!entries || entries.length < 2 || !first || !latest) return [message]
    if (message.id !== first.id) return []

    const parts = entries.flatMap((entry) => entry.parts)
    return [
      Object.assign({}, latest, {
        id: first.id,
        parentId: first.parentId,
        createdAt: first.createdAt,
        parts,
        text: parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n"),
      }),
    ]
  })
}
