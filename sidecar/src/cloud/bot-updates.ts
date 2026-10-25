import type { Bot, ServiceMap } from "@touri/contracts"

/** Each bot sends one configuration at a time and retains only its latest waiting snapshot. */
export const createCloudBotUpdates = ({
  getInstructions,
  send,
}: {
  getInstructions: ServiceMap["bots.instructions"]
  send: (bot: Bot, signal: AbortSignal) => Promise<void>
}) => {
  // Pending snapshots and active requests belong only to this connection's lifecycle.
  const pending = new Map<string, Bot>()
  const active = new Map<string, Promise<void>>()
  const shutdown = new AbortController()

  const update = async (bot: Bot): Promise<void> => {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)])
    signal.throwIfAborted()
    const instructions = bot.instructionsDeferred
      ? await getInstructions({ botId: bot.id, instructionsHash: bot.instructionsHash, signal })
      : bot.instructions
    // A deleted or superseded revision cannot erase text or mix unrelated metadata and instructions.
    if (instructions === undefined || signal.aborted) return
    await send(Object.assign({}, bot, { instructions, instructionsDeferred: false }), signal)
  }

  const getNextBot = (): Bot | undefined => {
    // At most eight active IDs can precede the next waiting bot.
    for (const bot of pending.values()) if (!active.has(bot.id)) return bot
    return undefined
  }

  const start = (): void => {
    if (shutdown.signal.aborted) return
    for (let count = active.size; count < 8; count += 1) {
      const bot = getNextBot()
      if (!bot) return
      // Reserve ownership before any asynchronous read can complete.
      active.set(
        bot.id,
        Promise.resolve().then(() => drain(bot.id)),
      )
    }
  }

  const drain = async (botId: string): Promise<void> => {
    try {
      for (;;) {
        const bot = pending.get(botId)
        if (!bot || shutdown.signal.aborted) return
        pending.delete(botId)
        await update(bot).catch(() => undefined)
      }
    } finally {
      active.delete(botId)
      start()
    }
  }

  const save = (bot: Bot): void => {
    if (shutdown.signal.aborted) return
    pending.set(bot.id, bot)
    start()
  }

  return {
    save,
    flushAsync: async (): Promise<void> => {
      while (active.size > 0) await Promise.all(active.values())
    },
    dispose: (): void => {
      shutdown.abort()
      pending.clear()
    },
  }
}
