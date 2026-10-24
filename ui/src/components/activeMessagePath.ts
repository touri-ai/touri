import type { Id, Message } from "@touri/contracts"

export const activeMessagePath = (messages: Array<Message>, leafId: Id | null): Array<Message> => {
  if (!leafId) return messages
  const byId = new Map(messages.map((message) => [message.id, message]))
  const path: Message[] = []
  const seen = new Set<Id>()
  let next: Id | null = leafId
  while (next && !seen.has(next)) {
    seen.add(next)
    const message = byId.get(next)
    if (!message) break
    path.unshift(message)
    next = message.parentId
  }
  return path
}
