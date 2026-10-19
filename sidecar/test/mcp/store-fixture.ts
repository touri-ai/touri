import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Bot, Message, StoreApi, Thread } from "@touri/contracts"

type Seed = {
  bots: Array<{ id: string; name: string; provider: "codex" | "claude"; paused: boolean }>
  threads: Array<{ id: string; botId: string; title: string }>
  messages: Array<{ id: string; threadId: string; role: "user" | "assistant"; text: string }>
}

const seed = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "ui-seed.json"), "utf8")) as Seed

const now = Date.now()

const makeBot = ({
  item,
  projectId,
  root,
}: {
  item: Seed["bots"][number]
  projectId: string | null
  root: string
}): Bot => ({
  teamBuilder: false,
  id: item.id,
  name: item.name,
  title: null,
  description: null,
  color: null,
  avatarPath: null,
  instructions: "fixture instructions",
  instructionsHash: "fixture-hash",
  provider: item.provider,
  model: null,
  reasoningEffort: null,
  access: "workspace-write",
  approvals: "on-request",
  projectId,
  cwd: null,
  homeDir: join(root, "bots", item.id),
  mainThreadId: null,
  browserEnabled: true,
  browser: "touri",
  computerUse: false,
  machine: "local",
  machineIdleMinutes: 15,
  vmProviderLogin: false,
  hostComputerUse: false,
  notifications: "all",
  section: null,
  sortOrder: 0,
  paused: item.paused,
  source: "local",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
})

const makeThread = (item: Seed["threads"][number]): Thread => ({
  id: item.id,
  botId: item.botId,
  parentThreadId: null,
  kind: "chat",
  title: item.title,
  activeLeafId: null,
  routineRunId: null,
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
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
})

const makeMessage = (item: Seed["messages"][number], index: number): Message => ({
  id: item.id,
  threadId: item.threadId,
  parentId: index === 0 ? null : (seed.messages[index - 1]?.id ?? null),
  role: item.role,
  kind: "text",
  status: "complete",
  runId: null,
  text: item.text,
  parts: [{ type: "text", text: item.text }],
  sender: null,
  source: "local",
  createdAt: now + index,
  updatedAt: now + index,
})

export const createFixtureStore = ({
  root,
  projectId = null,
}: {
  root: string
  projectId?: string | null
}): StoreApi => {
  const bots = seed.bots.map((item) => makeBot({ item, projectId, root }))
  const threads = seed.threads.map(makeThread)
  const messages = seed.messages.map(makeMessage)
  return {
    insertMessage: ({ message }) => {
      const thread = threads.find((item) => item.id === message.threadId)
      if (!thread) return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Thread not found" }
      if (message.parentId && !messages.some((item) => item.id === message.parentId))
        return { success: false, errorCode: "PARENT_NOT_FOUND", error: "Parent not found" }
      const created: Message = { ...message, createdAt: Date.now(), updatedAt: Date.now() }
      messages.push(created)
      return { success: true, message: created }
    },
    appendDelta: ({ messageId, delta }) => {
      const message = messages.find((item) => item.id === messageId)
      if (message) message.text += delta
    },
    updateMessage: ({ messageId, patch }) => {
      const message = messages.find((item) => item.id === messageId)
      if (!message) return { success: false, errorCode: "NOT_FOUND", error: "Message not found" }
      Object.assign(message, patch, { updatedAt: Date.now() })
      return { success: true, message }
    },
    activePath: ({ threadId, leafId }) => {
      const owned = messages.filter((item) => item.threadId === threadId)
      if (!leafId) return owned
      const leaf = owned.find((item) => item.id === leafId)
      return leaf ? owned.filter((item) => item.createdAt <= leaf.createdAt) : []
    },
    setActiveLeaf: ({ threadId, leafId }) => {
      const thread = threads.find((item) => item.id === threadId)
      if (!thread) return { success: false, errorCode: "NOT_FOUND", error: "Thread not found" }
      thread.activeLeafId = leafId
      return { success: true, thread }
    },
    getBot: ({ botId }) => bots.find((item) => item.id === botId) ?? null,
    getThread: ({ threadId }) => threads.find((item) => item.id === threadId) ?? null,
    createThread: ({ botId, kind, title, parentThreadId, routineRunId }) => {
      if (!bots.some((item) => item.id === botId))
        return { success: false, errorCode: "BOT_NOT_FOUND", error: "Bot not found" }
      const thread: Thread = {
        ...makeThread({ id: `created-${threads.length}`, botId, title }),
        kind,
        parentThreadId: parentThreadId ?? null,
        routineRunId: routineRunId ?? null,
      }
      threads.push(thread)
      return { success: true, thread }
    },
    updateThread: ({ threadId, patch }) => {
      const thread = threads.find((item) => item.id === threadId)
      if (!thread) return { success: false, errorCode: "NOT_FOUND", error: "Thread not found" }
      Object.assign(thread, patch, { updatedAt: Date.now() })
      return { success: true, thread }
    },
    search: ({ q, botId, threadId, limit }) => {
      const needle = q.toLocaleLowerCase()
      const allowedThreads = threads.filter(
        (thread) =>
          (botId === undefined || thread.botId === botId) && (threadId === undefined || thread.id === threadId),
      )
      return messages
        .filter((message) => allowedThreads.some((thread) => thread.id === message.threadId))
        .filter((message) => message.text.toLocaleLowerCase().includes(needle))
        .slice(0, limit)
        .map((message) => ({ threadId: message.threadId, messageId: message.id, snippet: message.text }))
    },
  }
}
