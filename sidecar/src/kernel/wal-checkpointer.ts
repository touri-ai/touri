import type { Database } from "bun:sqlite"
import { walCheckpointSource } from "./wal-checkpoint-worker"

const DEFAULT_INTERVAL_MS = 5_000
const STARTUP_TIMEOUT_MS = 15_000

export const createWalCheckpointer = ({
  database,
  onError,
  onReady,
  intervalMs = DEFAULT_INTERVAL_MS,
  createWorker = (url) => new Worker(url, { smol: true, ref: false }),
}: {
  database: Database
  onError: () => void
  onReady?: () => void
  intervalMs?: number
  createWorker?: (url: string) => Worker
}): { dispose: (options?: { closing?: boolean }) => void } => {
  const previousPages = (database.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number })
    .wal_autocheckpoint
  const fallbackPages = previousPages > 0 ? previousPages : 1_000
  // Mutable handles belong only to this connection's maintenance lifecycle.
  let worker: Worker | undefined
  let workerUrl: string | undefined
  let stopped = false
  let reportedError = false
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    clearTimeout(startupTimer)
    clearTimeout(stopTimer)
    worker?.terminate()
    worker = undefined
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = undefined
  }
  const restoreAutocheckpoint = (): void => {
    // Setting the threshold does no checkpoint I/O. Degraded commits use SQLite's safety net.
    database.exec(`PRAGMA wal_autocheckpoint = ${fallbackPages}`)
  }
  const reportError = (): void => {
    if (stopped || reportedError) return
    reportedError = true
    restoreAutocheckpoint()
    finish()
    onError()
  }

  try {
    database.exec("PRAGMA wal_autocheckpoint = 0")
    workerUrl = URL.createObjectURL(new Blob([walCheckpointSource], { type: "application/javascript" }))
    worker = createWorker(workerUrl)
    worker.onmessage = ({ data }: MessageEvent<{ type?: string }>): void => {
      if (data?.type === "stopped") {
        finish()
        return
      }
      if (stopped || reportedError) return
      if (data?.type === "error") {
        reportError()
        return
      }
      if (data?.type !== "ready") return

      clearTimeout(startupTimer)
      onReady?.()
    }
    worker.onerror = (event): void => {
      event.preventDefault()
      reportError()
    }
    worker.addEventListener("close", reportError)
    startupTimer = setTimeout(reportError, STARTUP_TIMEOUT_MS)
    startupTimer.unref()
    worker.postMessage({ type: "start", filename: database.filename, intervalMs })
  } catch {
    reportError()
  }

  return {
    dispose: ({ closing = false }: { closing?: boolean } = {}): void => {
      if (stopped) return
      stopped = true
      // Shutdown closes the connection next; it may already have lost its backing file.
      if (!closing) restoreAutocheckpoint()
      clearTimeout(startupTimer)
      if (!worker) {
        finish()
        return
      }

      stopTimer = setTimeout(finish, 1_000)
      stopTimer.unref()
      try {
        worker.postMessage({ type: "stop" })
      } catch {
        finish()
      }
    },
  }
}
