import type { Database } from "bun:sqlite"
import type { Kernel, NotifyKind } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"
import { createNotifier } from "./notifier"
import { createRecoverySync } from "./recovery"
import { createNotifyRoutes } from "./routes"
import { createSseHub } from "./sse"
import { createNotificationStore } from "./store"

export const name = "notify"

const RESOLVED_BY_USER_REPLY: ReadonlyArray<NotifyKind> = ["question", "turn-failed", "routine-failed"]
const RESOLVED_BY_NEW_RUN: ReadonlyArray<NotifyKind> = ["turn-failed", "routine-failed", "routine-deferred"]

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  const store = createNotificationStore({ db: kernel.db as Database })
  const hub = createSseHub({ store })
  const notifier = createNotifier({ kernel, store, hub })

  kernel.services.provide("notify.emit", notifier.emit)
  kernel.services.provide("notify.resolve", ({ requestId, resolution }) => {
    notifier.resolveRequest({ requestId, resolution })
  })

  const syncRecoveryTasks = createRecoverySync(kernel, store, notifier, runStage)
  syncRecoveryTasks({ silent: true })

  // Heal history written by an older runtime or a completion missed while restarting.
  const reconcileHistory = (): void => {
    const historical = (kernel.db as Database)
      .query(`SELECT DISTINCT n.id FROM notifications n
        JOIN runs r ON r.bot_id = n.bot_id
        JOIN threads t ON t.id = r.thread_id
        WHERE n.resolved_at IS NULL AND n.kind IN ('turn-failed', 'routine-failed', 'routine-deferred')
          AND n.thread_id = COALESCE(t.group_thread_id, r.thread_id)
          AND r.status = 'succeeded' AND r.finished_at > n.created_at`)
      .all() as Array<{ id: number }>
    historical.forEach((item) => {
      notifier.finish({ id: item.id, resolution: "expired" })
    })
  }
  if (runStage) runStage("notification_history_reconcile", reconcileHistory)
  else reconcileHistory()

  kernel.subscribe(({ event }) => {
    if (event.type === "run.updated" && ["queued", "starting", "running", "succeeded"].includes(event.run.status)) {
      const { run } = event
      const threadId =
        kernel.services.use("store.api")?.getThread({ threadId: run.threadId })?.groupThreadId ?? run.threadId
      const handledAt = run.status === "succeeded" ? run.finishedAt : (run.startedAt ?? run.queuedAt)
      for (const item of store.unresolvedForThread({ threadId, kinds: RESOLVED_BY_NEW_RUN }))
        if (handledAt !== null && item.botId === run.botId && item.createdAt <= handledAt)
          notifier.finish({ id: item.id, resolution: "expired" })
    }
    if (event.type !== "message.created" || event.message.role !== "user") return
    for (const item of store.unresolvedForThread({ threadId: event.message.threadId, kinds: RESOLVED_BY_USER_REPLY }))
      notifier.finish({ id: item.id, resolution: "replied" })
  })

  kernel.registerRoutes(createNotifyRoutes({ kernel, store, notifier, hub, syncRecoveryTasks }))
}
