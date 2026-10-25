import type { Database } from "bun:sqlite"
import type { Kernel } from "@touri/contracts"
import { yieldBackground } from "../kernel/background-task"
import { writeDatabaseAsync } from "../kernel/database-write"
import type { PerformanceStageRunner } from "../kernel/performance"
import { materializeTranscriptBatch } from "../kernel/transcript-storage"
import { reconcileBotHome } from "./bot-home"
import { createStoreReader } from "./reader"

export const createStartupRecovery = (
  kernel: Kernel,
  runStage?: PerformanceStageRunner,
  reconcileHome = reconcileBotHome,
  reader = createStoreReader((kernel.db as Database).filename),
) => {
  const database = kernel.db as Database
  const bots = new Map<string, Promise<void>>()
  const threads = new Map<string, Promise<void>>()
  let stopped = false
  const measure = <Value>(stage: Parameters<PerformanceStageRunner>[0], action: () => Value): Value =>
    runStage ? runStage(stage, action) : action()
  const hasPendingThread = (threadId: string): boolean =>
    Boolean(database.query("SELECT 1 FROM transcript_pending_deltas WHERE thread_id = ? LIMIT 1").get(threadId))
  const ensureBot = (botId: string): Promise<void> => {
    const pending = bots.get(botId)
    if (pending) return pending

    const ready = (async () => {
      const rows = await reader.getRows<{ id: string; instructions: string }>(
        {
          sql: "SELECT id, instructions FROM bots WHERE id = ?",
          bindings: [botId],
          chunkedStrings: true,
        },
        AbortSignal.timeout(15_000),
      )
      const bot = rows[0]
      if (!bot || stopped) return

      await measure("store_bot_home_startup_recovery", () => reconcileHome(kernel, bot))
    })().catch((error: unknown) => {
      bots.delete(botId)
      throw error
    })
    bots.set(botId, ready)
    return ready
  }
  const ensureThread = (threadId: string): Promise<void> => {
    const pending = threads.get(threadId)
    if (pending) return pending
    if (!hasPendingThread(threadId)) return Promise.resolve()

    const ready = (async () => {
      while (!stopped && hasPendingThread(threadId)) {
        await measure("store_transcript_startup_recovery", () =>
          writeDatabaseAsync(database, () => materializeTranscriptBatch(database, threadId)),
        )
        await yieldBackground()
      }
    })().finally(() => threads.delete(threadId))
    threads.set(threadId, ready)
    return ready
  }
  const ready = measure("store_transcript_startup_recovery", async () => {
    await yieldBackground()
    let cursor = ""
    while (!stopped) {
      const bot = database.query("SELECT id FROM bots WHERE id > ? ORDER BY id LIMIT 1").get(cursor) as {
        id: string
      } | null
      if (!bot) break

      await ensureBot(bot.id)
      cursor = bot.id
      await yieldBackground()
    }
    while (!stopped) {
      const pending = database
        .query("SELECT thread_id FROM transcript_pending_deltas ORDER BY thread_id LIMIT 1")
        .get() as {
        thread_id: string
      } | null
      if (!pending) return

      await ensureThread(pending.thread_id)
      if (!stopped) kernel.publish({ type: "transcript.resync" })
      await yieldBackground()
    }
  }).catch(() => {
    if (!stopped) kernel.log({ level: "error", module: "store", msg: "STORE_STARTUP_RECOVERY_FAILED" })
  })

  return {
    ready,
    ensureBot,
    ensureThread,
    dispose: async () => {
      stopped = true
      reader.dispose()
      await ready
      await Promise.allSettled(Array.from(threads.values()).concat(Array.from(bots.values())))
    },
  }
}
