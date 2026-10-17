import type { Database } from "bun:sqlite"
import type { ComputerInput, Kernel, ToolResult } from "@touri/contracts"

/** One input owner per VM. A lost viewer never counts as the human returning control. */
export const createComputerInput = (kernel: Kernel): ComputerInput => {
  const db = kernel.db as Database
  db.exec("CREATE TABLE IF NOT EXISTS computer_handoffs (bot_id TEXT PRIMARY KEY)")
  const humans = new Set(
    (db.query("SELECT bot_id FROM computer_handoffs").all() as Array<{ bot_id: string }>).map((row) => row.bot_id),
  )
  const active = new Map<string, AbortController>()
  const waiters = new Set<() => void>()
  const restored = new Map<string, number>()
  let epoch = 0
  const wake = () => {
    for (const waiter of waiters) waiter()
    waiters.clear()
  }
  const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done)
        waiters.delete(done)
        resolve()
      }
      waiters.add(done)
      signal.addEventListener("abort", done, { once: true })
      if (signal.aborted) done()
    })
  const publish = (botId: string, human: boolean) => kernel.publish({ type: "desktop.control", botId, human })
  const stopped = (): ToolResult => ({
    success: false,
    errorCode: "COMPUTER_KILLED",
    error: "O controle foi interrompido. Assuma e devolva ao bot para permitir novas entradas.",
  })
  return {
    human: (botId) => humans.has(botId),
    take: async (botId, signal) => {
      signal.throwIfAborted()
      db.query("INSERT OR IGNORE INTO computer_handoffs (bot_id) VALUES (?)").run(botId)
      humans.add(botId)
      publish(botId, true)
      // Finish the current atomic input before giving the person a keyboard; never replay it.
      while (active.has(botId) && !signal.aborted) await wait(signal)
      signal.throwIfAborted()
    },
    handBack: (botId) => {
      db.query("DELETE FROM computer_handoffs WHERE bot_id = ?").run(botId)
      humans.delete(botId)
      restored.set(botId, epoch)
      publish(botId, false)
      wake()
    },
    run: async (ctx, operation) => {
      const startEpoch = epoch
      while ((humans.has(ctx.botId) || active.has(ctx.botId)) && !ctx.signal.aborted) {
        if (startEpoch !== epoch || (epoch > 0 && restored.get(ctx.botId) !== epoch)) return stopped()
        await wait(ctx.signal)
      }
      if (ctx.signal.aborted) return { success: false, errorCode: "CANCELED", error: "Operação cancelada" }
      if (startEpoch !== epoch || (epoch > 0 && restored.get(ctx.botId) !== epoch)) return stopped()
      const controller = new AbortController()
      active.set(ctx.botId, controller)
      try {
        const result = await operation(AbortSignal.any([ctx.signal, controller.signal]))
        return startEpoch === epoch ? result : stopped()
      } finally {
        active.delete(ctx.botId)
        wake()
      }
    },
    kill: () => {
      epoch += 1
      for (const controller of active.values()) controller.abort()
      wake()
    },
  }
}
