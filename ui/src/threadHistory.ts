import type { Message, MessageHistoryContext, Run } from "@touri/contracts"

export const historyPageSize = 40
export type ThreadHistory = {
  messages: Message[]
  runs: Run[]
  runsReady?: boolean | undefined
  context?: MessageHistoryContext | undefined
  before: string | null
  activeLeafId?: string | null | undefined
}

/** Session memory only: never persist transcripts or share them across identities/reconnect snapshots. */
export const createThreadHistoryCache = () => {
  const pages = new Map<string, ThreadHistory>()
  const sizes = new Map<string, number>()
  const remove = (threadId: string): void => {
    pages.delete(threadId)
    sizes.delete(threadId)
  }
  const save = (threadId: string, history: ThreadHistory): void => {
    const messages = history.messages.slice(-historyPageSize)
    const runIds = new Set(messages.flatMap((message) => (message.runId ? [message.runId] : [])))
    const runs = history.runs.filter(
      (run) =>
        runIds.has(run.id) ||
        messages.some((message) => message.id === run.requestMessageId) ||
        ["queued", "starting", "running"].includes(run.status),
    )
    const parents = new Set(messages.map((message) => JSON.stringify([message.parentId, message.role])))
    const context = history.context
      ? {
          ...history.context,
          siblings: history.context.siblings
            .filter((message) => parents.has(JSON.stringify([message.parentId, message.role])))
            .slice(0, 200),
        }
      : undefined
    const page = {
      messages,
      runs,
      runsReady: history.runsReady ?? true,
      context,
      activeLeafId: history.activeLeafId,
      before: history.messages.length > messages.length ? (messages[0]?.id ?? null) : history.before,
    }
    // Only bounded pages are sized, once per save; oversize tool results are never cached.
    const bytes =
      messages.reduce(
        (total, message) =>
          total +
          message.text.length * 2 +
          message.parts.reduce(
            (size, part) =>
              size +
              Object.values(part).reduce<number>(
                (length, value) => length + (typeof value === "string" ? value.length * 2 : 16),
                0,
              ),
            0,
          ) +
          1024,
        0,
      ) +
      runs.length * 4096 +
      (context?.siblings.length ?? 0) * 512
    remove(threadId)
    if (bytes > 4 * 1024 * 1024) return

    pages.set(threadId, page)
    sizes.set(threadId, bytes)
    while (pages.size > 8 || Array.from(sizes.values()).reduce((total, size) => total + size, 0) > 16 * 1024 * 1024) {
      const oldest = pages.keys().next().value
      if (!oldest) break
      remove(oldest)
    }
  }

  return {
    get: (threadId: string, activeLeafId?: string | null) => {
      const page = pages.get(threadId)
      if (activeLeafId !== undefined && page?.activeLeafId !== activeLeafId) return undefined

      return page
    },
    save,
    remove,
    clear: (): void => {
      pages.clear()
      sizes.clear()
    },
  }
}
