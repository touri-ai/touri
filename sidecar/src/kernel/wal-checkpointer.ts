import type { Database } from "bun:sqlite"
import { walCheckpointSource } from "./wal-checkpoint-worker"
import { getWorkerExit } from "./worker-exit"
import { deferWorkerReply } from "./worker-reply"

const DEFAULT_INTERVAL_MS = 5_000
const PAGE_INTERVAL_MS = 5_000
const STARTUP_TIMEOUT_MS = 15_000
type RefableWorker = Worker & { ref: () => void; unref: () => void }

export const createWalCheckpointer = ({
  database,
  onError,
  onReady,
  intervalMs = DEFAULT_INTERVAL_MS,
  pageIntervalMs = PAGE_INTERVAL_MS,
  createWorker = (url) => new Worker(url, { smol: true, ref: false }),
}: {
  database: Pick<Database, "filename" | "query" | "exec">
  onError: (status: { autocheckpointRestored: boolean }) => void
  onReady?: () => void
  intervalMs?: number
  pageIntervalMs?: number
  createWorker?: (url: string) => Worker
}): { dispose: (options?: { closing?: boolean }) => Promise<void>; vacuum: () => Promise<void> } => {
  const previousPages = (database.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number })
    .wal_autocheckpoint
  const fallbackPages = previousPages > 0 ? previousPages : 1_000
  // Mutable handles belong only to this connection's maintenance lifecycle.
  let worker: RefableWorker | undefined
  let workerExited: Promise<void> = Promise.resolve()
  let workerUrl: string | undefined
  let stopped = false
  let reportedError = false
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let requestId = 0
  const closed = Promise.withResolvers<void>()
  const pendingVacuum = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()

  const finish = (): void => {
    clearTimeout(startupTimer)
    clearTimeout(stopTimer)
    worker?.terminate()
    worker = undefined
    pendingVacuum.forEach(({ reject }) => {
      reject(new Error("WAL worker stopped before maintenance completed"))
    })
    pendingVacuum.clear()
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = undefined
    void workerExited.then(closed.resolve)
  }
  const restoreAutocheckpoint = (): boolean => {
    try {
      database.exec(`PRAGMA wal_autocheckpoint = ${fallbackPages}`)
      return true
    } catch {
      // A lost backing file or damaged connection must not escape a worker/timer error callback.
      return false
    }
  }
  const reportError = (): void => {
    if (stopped || reportedError) return
    reportedError = true
    const autocheckpointRestored = restoreAutocheckpoint()
    finish()
    onError({ autocheckpointRestored })
  }

  try {
    database.exec("PRAGMA wal_autocheckpoint = 0")
    workerUrl = URL.createObjectURL(new Blob([walCheckpointSource], { type: "application/javascript" }))
    worker = createWorker(workerUrl) as RefableWorker
    workerExited = getWorkerExit(worker)
    // Startup must make progress without an unrelated request waking the worker mailbox.
    worker.ref()
    worker.onmessage = ({ data }: MessageEvent<{ type?: string; requestId?: number; error?: string }>): void => {
      if (data?.type === "stopped") {
        finish()
        return
      }
      if (stopped || reportedError) return
      if (data?.type === "error") {
        reportError()
        return
      }
      if (data?.type === "vacuum-complete" && typeof data.requestId === "number") {
        const pending = pendingVacuum.get(data.requestId)
        if (!pending) return
        pendingVacuum.delete(data.requestId)
        if (data.error) pending.reject(new Error(data.error))
        else pending.resolve()
        return
      }
      if (data?.type !== "ready") return

      clearTimeout(startupTimer)
      // Readiness consumers may start another worker and await its first durable write.
      deferWorkerReply(() => {
        if (stopped || reportedError) return
        onReady?.()
        worker?.unref()
      })
    }
    worker.onerror = (event): void => {
      event.preventDefault()
      reportError()
    }
    worker.addEventListener("close", reportError)
    startupTimer = setTimeout(reportError, STARTUP_TIMEOUT_MS)
    worker.postMessage({ type: "start", filename: database.filename, intervalMs, pageIntervalMs })
  } catch {
    reportError()
  }

  return {
    vacuum: (): Promise<void> => {
      if (!worker) return Promise.reject(new Error("WAL worker is unavailable"))
      const id = ++requestId
      const result = new Promise<void>((resolve, reject) => pendingVacuum.set(id, { resolve, reject }))
      worker.postMessage({ type: "vacuum", requestId: id })
      return result
    },
    dispose: ({ closing = false }: { closing?: boolean } = {}): Promise<void> => {
      if (stopped) return closed.promise
      stopped = true
      // Shutdown closes the connection next; it may already have lost its backing file.
      if (!closing && !restoreAutocheckpoint() && !reportedError) {
        reportedError = true
        finish()
        onError({ autocheckpointRestored: false })
        return closed.promise
      }
      clearTimeout(startupTimer)
      if (!worker) {
        finish()
        return closed.promise
      }

      stopTimer = setTimeout(finish, 1_000)
      try {
        worker.postMessage({ type: "stop" })
      } catch {
        finish()
      }
      return closed.promise
    },
  }
}
