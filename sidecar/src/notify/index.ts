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

export const init = async (
  kernel: Kernel,
  runStage?: PerformanceStageRunner,
  yieldHistoryBatch: () => Promise<void> = () => Bun.sleep(0),
): Promise<void> => {
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
  const database = kernel.db as Database
  const reconcileHistory = async (): Promise<void> => {
    const storedProgress = getHistoryReconcileProgress(database)
    const progress = storedProgress ?? getNewHistoryReconcileProgress(database)
    if (!storedProgress) saveHistoryReconcileProgress(database, progress)
    await reconcileHistoryBatch({
      database,
      finishNotification: (id) => {
        notifier.finish({ id, resolution: "expired" })
      },
      progress,
      runStage,
      yieldHistoryBatch,
    })
    deleteHistoryReconcileProgress(database)
  }
  await reconcileHistory()

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

type HistoryReconcileProgress = { stage: "notification_history_reconcile"; cursor: number; upper: number }
type HistoryReconcileBatchOptions = {
  database: Database
  finishNotification: (id: number) => void
  progress: HistoryReconcileProgress
  runStage?: PerformanceStageRunner | undefined
  yieldHistoryBatch: () => Promise<void>
}

const HISTORY_RECONCILE_KEY = "notification.history-reconcile"

const getNewHistoryReconcileProgress = (database: Database): HistoryReconcileProgress => {
  const upper = (database.query("SELECT COALESCE(MAX(id),0) AS id FROM notifications").get() as { id: number }).id
  return { stage: "notification_history_reconcile", cursor: 0, upper }
}

const getHistoryReconcileProgress = (database: Database): HistoryReconcileProgress | null => {
  const row = database.query("SELECT value_json FROM settings WHERE key = ?").get(HISTORY_RECONCILE_KEY) as {
    value_json: string
  } | null
  if (!row) return null

  try {
    const value: unknown = JSON.parse(row.value_json)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const progress = value as Record<string, unknown>
    if (
      progress.stage !== "notification_history_reconcile" ||
      !Number.isSafeInteger(progress.cursor) ||
      !Number.isSafeInteger(progress.upper) ||
      Number(progress.cursor) < 0 ||
      Number(progress.upper) < Number(progress.cursor)
    )
      return null

    return {
      stage: "notification_history_reconcile",
      cursor: Number(progress.cursor),
      upper: Number(progress.upper),
    }
  } catch {
    return null
  }
}

const saveHistoryReconcileProgress = (database: Database, progress: HistoryReconcileProgress): void => {
  database
    .query(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(HISTORY_RECONCILE_KEY, JSON.stringify(progress), Date.now())
}

const deleteHistoryReconcileProgress = (database: Database): void => {
  database.query("DELETE FROM settings WHERE key = ?").run(HISTORY_RECONCILE_KEY)
}

const reconcileHistoryBatch = async ({
  database,
  finishNotification,
  progress,
  runStage,
  yieldHistoryBatch,
}: HistoryReconcileBatchOptions): Promise<void> => {
  if (progress.cursor >= progress.upper) return

  const upper = Math.min(progress.cursor + 50, progress.upper)
  const batch = () => {
    const rows = database
      .query(`SELECT n.id,
        (EXISTS(SELECT 1 FROM threads t JOIN runs r ON r.thread_id=t.id
          WHERE t.id=n.thread_id AND t.group_thread_id IS NULL AND t.bot_id=n.bot_id
            AND r.status='succeeded' AND r.finished_at>n.created_at)
         OR EXISTS(SELECT 1 FROM threads t JOIN runs r ON r.thread_id=t.id
          WHERE t.group_thread_id=n.thread_id AND t.bot_id=n.bot_id
            AND r.status='succeeded' AND r.finished_at>n.created_at)) AS expired
        FROM notifications n
        WHERE n.id>? AND n.id<=? AND n.resolved_at IS NULL
          AND n.kind IN ('turn-failed','routine-failed','routine-deferred')
        ORDER BY n.id LIMIT 50`)
      .all(progress.cursor, upper) as Array<{ id: number; expired: number }>
    rows
      .filter((item) => item.expired === 1)
      .forEach((item) => {
        finishNotification(item.id)
      })
  }
  if (runStage) runStage("notification_history_reconcile", batch)
  else batch()

  const next = { stage: progress.stage, cursor: upper, upper: progress.upper }
  saveHistoryReconcileProgress(database, next)
  if (next.cursor >= next.upper) return

  await yieldHistoryBatch()
  return reconcileHistoryBatch({ database, finishNotification, progress: next, runStage, yieldHistoryBatch })
}
