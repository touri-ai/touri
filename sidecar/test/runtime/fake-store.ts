import type { Bot, Id, Kernel, Message, StoreApi, Thread } from "@touri/contracts"

export type TestStore = StoreApi & { bots: Map<Id, Bot>; threads: Map<Id, Thread>; messages: Map<Id, Message> }

const now = (): number => Date.now()

export const createTestStore = ({
  bot,
  thread,
  publish,
  onCreateThread,
}: {
  bot: Bot
  thread: Thread
  publish?: Kernel["publish"]
  onCreateThread?: (thread: Thread) => void
}): TestStore => {
  const bots = new Map<Id, Bot>([[bot.id, bot]])
  const threads = new Map<Id, Thread>([[thread.id, thread]])
  const messages = new Map<Id, Message>()

  const insertMessage: StoreApi["insertMessage"] = ({ message }) => {
    const targetThread = threads.get(message.threadId)
    if (!targetThread) return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Thread not found" }
    if (message.parentId && !messages.has(message.parentId))
      return { success: false, errorCode: "PARENT_NOT_FOUND", error: "Parent not found" }
    const created: Message = { ...message, createdAt: now(), updatedAt: now() }
    messages.set(created.id, created)
    targetThread.activeLeafId = created.id
    targetThread.updatedAt = created.updatedAt
    publish?.({ type: "message.created", message: structuredClone(created) })
    return { success: true, message: created }
  }

  const appendDelta: StoreApi["appendDelta"] = ({ messageId, partIndex, delta }) => {
    const message = messages.get(messageId)
    if (!message) return
    const part = message.parts[partIndex]
    if (part?.type === "text" || part?.type === "reasoning") part.text += delta
    else message.parts[partIndex] = { type: "text", text: delta }
    if (part?.type !== "reasoning") message.text += delta
    message.updatedAt = now()
  }

  const updateMessage: StoreApi["updateMessage"] = ({ messageId, patch }) => {
    const message = messages.get(messageId)
    if (!message) return { success: false, errorCode: "NOT_FOUND", error: "Message not found" }
    Object.assign(message, patch, { updatedAt: now() })
    publish?.({ type: "message.updated", message: structuredClone(message) })
    return { success: true, message }
  }

  const activePath: StoreApi["activePath"] = ({ threadId, leafId }) => {
    const thread = threads.get(threadId)
    if (!thread) return []
    const path: Array<Message> = []
    let current = messages.get(leafId ?? thread.activeLeafId ?? "")
    while (current) {
      path.unshift(current)
      current = current.parentId ? messages.get(current.parentId) : undefined
    }
    return path
  }

  const createThread: StoreApi["createThread"] = ({ botId, kind, title, parentThreadId, routineRunId }) => {
    if (!bots.has(botId)) return { success: false, errorCode: "BOT_NOT_FOUND", error: "Bot not found" }
    const timestamp = now()
    const created: Thread = {
      id: `thread-${timestamp}-${Math.random()}`,
      botId,
      parentThreadId: parentThreadId ?? null,
      kind,
      title,
      activeLeafId: null,
      routineRunId: routineRunId ?? null,
      cwdOverride: null,
      unread: 0,
      carryoverNote: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: null,
        turns: 0,
        contextTokens: null,
        contextWindow: null,
      },
      source: "local",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    }
    threads.set(created.id, created)
    onCreateThread?.(created)
    return { success: true, thread: created }
  }

  const store: TestStore = {
    bots,
    threads,
    messages,
    insertMessage,
    appendDelta,
    updateMessage,
    activePath,
    setActiveLeaf: ({ threadId, leafId }) => {
      const target = threads.get(threadId)
      if (!target) return { success: false, errorCode: "NOT_FOUND", error: "Thread not found" }
      target.activeLeafId = leafId
      return { success: true, thread: target }
    },
    getBot: ({ botId }) => bots.get(botId) ?? null,
    getThread: ({ threadId }) => threads.get(threadId) ?? null,
    createThread,
    updateThread: ({ threadId, patch }) => {
      const target = threads.get(threadId)
      if (!target) return { success: false, errorCode: "NOT_FOUND", error: "Thread not found" }
      Object.assign(target, patch, { updatedAt: now() })
      return { success: true, thread: target }
    },
    search: ({ q, botId, threadId, limit }) =>
      [...messages.values()]
        .filter(
          (message) =>
            message.text.toLowerCase().includes(q.toLowerCase()) &&
            (!botId || threads.get(message.threadId)?.botId === botId) &&
            (!threadId || message.threadId === threadId),
        )
        .slice(0, limit)
        .map((message) => ({ threadId: message.threadId, messageId: message.id, snippet: message.text })),
  }
  return store
}
