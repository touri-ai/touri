import type { Database } from "bun:sqlite"
import type { Kernel, ToolHandler } from "@touri/contracts"
import { consentToPrivateHistory, groupHistoryThread } from "../../groups/privacy"
import { createStoreReader } from "../../store/reader"
import { getAsyncSearchHits } from "../../store/search-query"

type SearchArgs = { query: string; threadId?: string; limit?: number }

const parseArgs = (args: unknown): SearchArgs => args as SearchArgs

export const createHistorySearchHandler =
  ({ kernel }: { kernel: Kernel }): ToolHandler =>
  async ({ ctx, args }) => {
    const store = kernel.services.use("store.api")
    if (!store) return { success: false, errorCode: "STORE_UNAVAILABLE", error: "Conversation store is unavailable" }
    const input = parseArgs(args)
    const callerThread = store.getThread({ threadId: ctx.threadId })
    const groupThread = callerThread ? groupHistoryThread(callerThread) : null
    const threadId = input.threadId ?? groupThread ?? undefined
    const shared = groupThread !== null && threadId === groupThread
    if (threadId !== undefined) {
      const thread = store.getThread({ threadId })
      if (!thread || (!shared && thread.botId !== ctx.botId))
        return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Thread not found" }
      if (
        groupThread &&
        !shared &&
        threadId !== ctx.threadId &&
        !(await consentToPrivateHistory(kernel, ctx, threadId))
      )
        return {
          success: false,
          errorCode: "PRIVATE_HISTORY_CONSENT_REQUIRED",
          error: "O histórico privado exige aprovação humana para uso no grupo.",
        }
    }
    if (threadId === undefined) {
      try {
        await store.flushWritesAsync?.()
      } catch {
        try {
          kernel.log({
            level: "warn",
            module: "mcp",
            msg: "History search continued with persisted data after stream writes were rejected",
          })
        } catch {
          // A storage failure can also prevent writing the diagnostic.
        }
      }
    } else await store.flushWritesAsync?.({ threadId })
    const reader = createStoreReader((kernel.db as Database).filename)
    const searchInput = {
      q: input.query,
      ...(shared ? {} : { botId: ctx.botId }),
      ...(threadId === undefined ? {} : { threadId }),
      limit: input.limit ?? 10,
    }
    const results = await getAsyncSearchHits(reader, searchInput, ctx.signal).finally(reader.dispose)

    return {
      success: true,
      content: [{ type: "text", text: JSON.stringify({ results }) }],
    }
  }
