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

  // Live events append new threads, so snapshot order cannot select the newest conversations.
  const newest = getChannelThreads(threads, groupId)
    .slice(1)
    .reduce<Thread[]>((latest, thread) => {
      const oldest = latest.at(-1)
      if (latest.length === 50 && oldest && getThreadOrder(thread, oldest) >= 0) return latest

      return latest.concat(thread).toSorted(getThreadOrder).slice(0, 50)
    }, [])

  return newest.map((thread) => ({ thread, reply: replies.get(thread.id) }))
}

const getThreadOrder = (left: Thread, right: Thread): number =>
  right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
