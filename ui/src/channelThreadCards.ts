import type { Message, Thread } from "@touri/contracts"
import { getChannelThreads } from "./channelThreads"

export const getChannelThreadCards = (threads: readonly Thread[], messages: readonly Message[], groupId: string) => {
  // A local index keeps each update linear in the bounded workspace activity snapshot.
  const replies = new Map<string, Message>()
  messages.forEach((message) => {
    if (message.role !== "assistant" || !message.text.trim()) return
    const previous = replies.get(message.threadId)
    if (previous && previous.createdAt > message.createdAt) return

    replies.set(message.threadId, message)
  })

  return getChannelThreads(threads, groupId)
    .slice(1, 51)
    .map((thread) => ({ thread, reply: replies.get(thread.id) }))
}
