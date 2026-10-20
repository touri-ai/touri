import type { Database } from "bun:sqlite"
import type { PerformanceStageRunner } from "./performance"
import { workerEntrypoint } from "./worker-entrypoint"
import { deferWorkerReply } from "./worker-reply"
import { backfillWorkspaceAttentionBatch, type WorkspaceAttentionBatchResult } from "./workspace-attention-batch"
import type { WorkspaceAttentionWorkerReply } from "./workspace-attention-worker"

export { backfillWorkspaceAttentionBatch } from "./workspace-attention-batch"

export const startWorkspaceAttentionBackfill = (
  database: Database,
  onError: (error: unknown) => void,
  runStage?: PerformanceStageRunner,
  publishResync: () => void = () => {},
): (() => void | Promise<void>) => {
  if (!database.query("SELECT 1 FROM workspace_attention_backfill WHERE id = 1").get()) return () => {}

  // One outstanding batch and its handles belong to this backfill lifecycle.
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let worker: Worker | undefined
  let pending:
    | { resolve: (result: WorkspaceAttentionBatchResult) => void; reject: (error: unknown) => void }
    | undefined
  let busyAttempts = 0
  const settle = (reply: WorkspaceAttentionWorkerReply): void => {
    const request = pending
    pending = undefined
    clearTimeout(deadline)
    if (!request) return
    if (reply.type === "result") {
      request.resolve(reply.result)
      return
    }
    if (reply.type === "busy") {
      request.reject({ code: "SQLITE_BUSY" })
      return
    }

    request.reject(new Error("Workspace attention backfill deferred"))
  }
  const closeWorker = async (): Promise<void> => {
    const current = worker
    worker = undefined
    settle({ type: "error" })
    if (!current) return

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000)
      current.addEventListener(
        "close",
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
      current.terminate()
    })
  }
  const runBatch = (): Promise<WorkspaceAttentionBatchResult> => {
    // In-memory fixtures cannot share a connection; deployed stores always use the worker.
    if (!database.filename || database.filename === ":memory:")
      return Promise.resolve(withoutBusyWait(database, () => backfillWorkspaceAttentionBatch(database)))

    return new Promise((resolve, reject) => {
      if (!worker) {
        worker = new Worker(
          workerEntrypoint(
            new URL("./workspace-attention-worker.ts", import.meta.url),
            "./workspace-attention-worker-entry.ts",
          ),
          { smol: true, ref: false },
        )
        worker.onmessage = ({ data }: MessageEvent<WorkspaceAttentionWorkerReply>) =>
          deferWorkerReply(() => settle(data))
        worker.onerror = (event) => {
          event.preventDefault()
          deferWorkerReply(() => settle({ type: "error" }))
        }
        worker.addEventListener("close", () => deferWorkerReply(() => settle({ type: "error" })))
      }
      pending = { resolve, reject }
      deadline = setTimeout(() => settle({ type: "error" }), 30_000)
      worker.postMessage({ filename: database.filename })
    })
  }
  const step = async (): Promise<void> => {
    if (stopped) return
    try {
      const result = runStage ? await runStage("workspace_attention_backfill", runBatch) : await runBatch()
      if (stopped) return
      busyAttempts = 0
      if (result.done) {
        await closeWorker()
        if (!stopped) withoutBusyWait(database, publishResync)
        return
      }
      timer = setTimeout(step, 10)
    } catch (error) {
      if (stopped) return
      if (isSqliteBusy(error)) {
        const delayMs = Math.min(1_000, 50 * 2 ** Math.min(busyAttempts, 4))
        busyAttempts += 1
        timer = setTimeout(step, delayMs)
        return
      }
      await closeWorker()
      if (stopped) return
      onError(error)
      timer = setTimeout(step, 1000)
    }
  }

  // Give the listener and first requests a turn before scanning historical rows.
  timer = setTimeout(step, 25)
  return () => {
    stopped = true
    clearTimeout(timer)
    if (!worker && !pending) return

    return closeWorker()
  }
}

const isSqliteBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))

const withoutBusyWait = <Value>(database: Database, operation: () => Value): Value => {
  const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
  database.exec("PRAGMA busy_timeout = 0")
  try {
    return operation()
  } finally {
    database.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
  }
}
