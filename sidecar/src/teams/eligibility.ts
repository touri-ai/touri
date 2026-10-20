import type { Database } from "bun:sqlite"
import type { Kernel, ToolContext } from "@touri/contracts"
import { getDelegation } from "../groups/security"

type Caller = Pick<ToolContext, "botId" | "threadId">

/** Check trusted run provenance too: an automatic continuation can have trigger=user. */
export const getTeamBuilder = (kernel: Kernel, caller: Caller) => {
  const store = kernel.services.use("store.api")
  const bot = store?.getBot({ botId: caller.botId })
  const thread = store?.getThread({ threadId: caller.threadId })
  const run = kernel.services.use("runtime.activeRun")?.({ threadId: caller.threadId })
  if (!bot?.teamBuilder || bot.paused || bot.archivedAt || thread?.botId !== bot.id) return null
  if (
    thread.kind === "routine" ||
    thread.groupId ||
    thread.groupThreadId ||
    thread.routineRunId ||
    getDelegation(kernel, caller.threadId)
  )
    return null
  if (
    !run ||
    run.botId !== bot.id ||
    run.threadId !== thread.id ||
    !["starting", "running"].includes(run.status) ||
    !["user", "retry"].includes(run.trigger) ||
    run.routineRunId ||
    run.groupThreadId ||
    (run.origin && run.origin !== "message") ||
    !run.requestMessageId
  )
    return null
  const request = store?.getPathMessage?.({ threadId: thread.id, messageId: run.requestMessageId })
  if (request?.role !== "user" || request.parts.some((part) => part.type === "notice")) return null
  const isAdminRun = kernel.services.use("work.isAdminRun")
  if (isAdminRun ? !isAdminRun(run.id) : request.sender !== null) return null
  const db = kernel.db as Database
  if (db.query("SELECT 1 FROM run_continuations WHERE run_id = ?").get(run.id)) return null
  return { bot, run }
}
