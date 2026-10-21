import type { Id } from "@touri/contracts"

type Scope = { threadId: Id }

/** A tab can outlive its conversation; shared frames must follow the current browser request. */
export const createBrowserPreviewScopes = () => {
  const scopes = new Map<Id, Scope>()

  return {
    set: (botId: Id, threadId: Id): void => {
      if (!scopes.has(botId) && scopes.size >= 512) scopes.clear()
      scopes.set(botId, { threadId })
    },
    capture: async <Frame>({
      botId,
      canReadThread,
      capture,
    }: {
      botId: Id
      canReadThread: (threadId: Id) => boolean
      capture: () => Promise<Frame | null>
    }): Promise<Frame | null> => {
      const scope = scopes.get(botId)
      if (!scope || !canReadThread(scope.threadId)) return null

      const frame = await capture()
      if (scopes.get(botId) !== scope || !canReadThread(scope.threadId)) return null

      return frame
    },
  }
}
