import type { Database } from "bun:sqlite"
import type { UiEvent } from "@touri/contracts"
import { privateFileExistsAsync, writePrivateFileAsync } from "../kernel/async-files"
import type { OutputBlobAttachment, OutputBlobWrite } from "../kernel/output-blobs"
import { streamPersistenceWorkerSource } from "./stream-persistence-worker"

type StreamEvent = Extract<UiEvent, { type: "message.delta" | "message.parts" }>
type DeltaWrite = Extract<UiEvent, { type: "message.delta" }> & { expectedSeq?: number; snapshotSeq?: number }
export type RejectionWrite = {
  type: "stream.rejection"
  threadId: string
  messageId: string
  partIndex: number
  generation?: number
  expectedSeq?: number
  reason: "validation" | "oversize" | "stale_generation" | "seq_conflict"
}
type StreamWriteEvent =
  | DeltaWrite
  | (Extract<UiEvent, { type: "message.parts" }> & { snapshotSeq?: number })
  | RejectionWrite
type CommittedBatch = {
  type: "committed"
  id: string
  events: StreamEvent[]
  rejected: Array<Extract<UiEvent, { type: "transcript.rejected" }>>
  published: UiEvent[]
  quarantined?: boolean
}
type WorkerMessage =
  | CommittedBatch
  | { type: "ready" | "stopped" }
  | { type: "startup-error"; busy: boolean; code?: string }
  | { type: "batch-error"; id: string; busy: boolean }
type Batch = { id: string; events: StreamWriteEvent[]; attachments: OutputBlobAttachment[]; quarantine?: boolean }
type PendingBatch = {
  batch: Batch
  files: OutputBlobWrite[]
  bytes: number
  attempts: number
  failures: number
  filesWritten: boolean
  promise: Promise<CommittedBatch>
  resolve: (result: CommittedBatch) => void
  reject: (error: Error) => void
}

export const STREAM_PERSISTENCE_LIMITS = { bytes: 8 * 1024 * 1024, events: 4_096 }
const RETRY_DELAY_MS = 100
const MAX_RETRY_DELAY_MS = 1_000
const MAX_ATTEMPTS = 4
const STARTUP_TIMEOUT_MS = 15_000
const READY_WAIT_LIMIT_MS = 10_000

export const createStreamPersistence = ({
  database,
  appData,
  publish,
  onError,
  onReadyWaitExceeded,
  readyWaitLimitMs = READY_WAIT_LIMIT_MS,
  createWorker = (url) => new Worker(url, { smol: true, ref: false }),
}: {
  database: Database
  appData: string
  publish: (event: UiEvent) => void
  onError: () => void
  onReadyWaitExceeded?: () => void
  readyWaitLimitMs?: number
  createWorker?: (url: string) => Worker
}) => {
  // The worker owns transactions; this bounded FIFO owns admission, retries and acknowledgements.
  let queue: PendingBatch[] = []
  let queuedBytes = 0
  let queuedEvents = 0
  const workerUrl = URL.createObjectURL(new Blob([streamPersistenceWorkerSource], { type: "application/javascript" }))
  let worker: Worker | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let readyWaitTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let workerNumber = 0
  let startupAttempts = 0
  let busyStartupAttempts = 0
  let ready = false
  let running = false
  let stopping = false
  let disposed = false
  let unavailable: Error | undefined
  let reportedError = false
  let resolveReady: () => void = () => {}
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const settleReady = (): void => {
    clearTimeout(readyWaitTimer)
    readyWaitTimer = undefined
    resolveReady()
  }

  const reportError = (): void => {
    if (reportedError) return
    reportedError = true
    try {
      onError()
    } catch {
      // A storage failure can also prevent writing its diagnostic.
    }
  }
  const sendResync = (): void => {
    try {
      publish({ type: "transcript.resync" })
    } catch {
      reportError()
    }
  }
  const removeHead = (): PendingBatch | undefined => {
    const head = queue[0]
    if (!head) return
    queue = queue.slice(1)
    queuedBytes -= head.bytes
    queuedEvents -= head.batch.events.length
    running = false
    return head
  }
  const scheduleRetry = (attempt: number, action: () => void): void => {
    if (disposed || retryTimer) return
    const delayMs = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** Math.min(attempt - 1, 4))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      action()
    }, delayMs)
    retryTimer.unref()
  }
  const stopWorker = (): void => {
    clearTimeout(startupTimer)
    workerNumber += 1
    worker?.terminate()
    worker = undefined
    ready = false
    running = false
  }
  const failStartup = (busy = false): void => {
    if (!busy) reportError()
    stopWorker()
    if (busy) {
      busyStartupAttempts += 1
      scheduleRetry(busyStartupAttempts, startWorker)
      return
    }
    busyStartupAttempts = 0
    startupAttempts += 1
    if (startupAttempts < MAX_ATTEMPTS) {
      scheduleRetry(startupAttempts, startWorker)
      return
    }
    unavailable = new Error("Stream persistence could not start")
    const abandoned = queue
    queue = []
    queuedBytes = 0
    queuedEvents = 0
    abandoned.forEach(({ reject }) => {
      reject(unavailable ?? new Error("Stream persistence unavailable"))
    })
    settleReady()
    sendResync()
  }
  const retryHead = (busy = false): void => {
    const head = queue[0]
    if (!head) return
    running = false
    head.attempts += 1
    if (!busy) head.failures += 1
    if (head.failures >= MAX_ATTEMPTS && head.batch.quarantine) {
      removeHead()?.reject(new Error("Stream batch could not be quarantined"))
      sendResync()
      commitHead()
      return
    }
    if (head.failures >= MAX_ATTEMPTS) {
      // A poison batch cannot monopolize other threads. Persist rejections instead of its payload.
      head.batch = { ...head.batch, quarantine: true }
      head.attempts = 0
      head.failures = 0
      reportError()
    }
    scheduleRetry(Math.max(1, head.attempts), () => {
      if (!worker) startWorker()
      else commitHead()
    })
  }
  const recoverWorker = (number: number): void => {
    if (number !== workerNumber || disposed) return
    reportError()
    const wasReady = ready
    stopWorker()
    if (!wasReady) {
      failStartup()
      return
    }
    retryHead()
    if (!queue.length) scheduleRetry(1, startWorker)
  }
  const commitHead = (): void => {
    if (!ready || running || retryTimer || !queue.length) return
    const head = queue[0]
    if (!head || !worker) return
    running = true
    const currentWorker = worker
    const number = workerNumber
    void (async () => {
      if (!head.batch.quarantine && !head.filesWritten) {
        for (const file of head.files) {
          // A failed directory fsync can leave the renamed file visible; retries must persist it again.
          if (head.attempts === 0 && (await privateFileExistsAsync({ root: appData, path: file.path }))) continue

          await writePrivateFileAsync({ root: appData, path: file.path, content: file.content })
        }
        head.filesWritten = true
      }
      if (number !== workerNumber || disposed || currentWorker !== worker) return

      try {
        currentWorker.postMessage({ type: "batch", batch: head.batch })
      } catch {
        recoverWorker(number)
      }
    })().catch(() => {
      if (number !== workerNumber || disposed) return

      reportError()
      retryHead()
    })
  }
  const startWorker = (): void => {
    if (disposed || unavailable || worker) return
    try {
      workerNumber += 1
      const number = workerNumber
      worker = createWorker(workerUrl)
      worker.onmessage = ({ data }: MessageEvent<WorkerMessage>): void => {
        if (number !== workerNumber || disposed) return
        if (data?.type === "ready") {
          clearTimeout(startupTimer)
          startupAttempts = 0
          busyStartupAttempts = 0
          ready = true
          settleReady()
          commitHead()
          return
        }
        if (data?.type === "startup-error") {
          failStartup(data.busy)
          return
        }
        if (data?.type === "batch-error") {
          if (queue[0]?.batch.id !== data.id) return
          if (!data.busy) reportError()
          retryHead(data.busy)
          return
        }
        if (data?.type !== "committed") return
        if (queue[0]?.batch.id !== data.id) {
          recoverWorker(number)
          return
        }
        const head = removeHead()
        if (!head) return
        reportedError = false
        // Delivery failure must never retry a committed payload.
        data.published.forEach((event) => {
          try {
            publish(event)
          } catch {
            reportError()
          }
        })
        head.resolve(data)
        commitHead()
      }
      worker.onerror = (event): void => {
        event.preventDefault()
        recoverWorker(number)
      }
      worker.addEventListener("close", () => recoverWorker(number))
      startupTimer = setTimeout(() => recoverWorker(number), STARTUP_TIMEOUT_MS)
      startupTimer.unref()
      worker.postMessage({ type: "start", filename: database.filename })
    } catch {
      failStartup()
    }
  }
  const submit = (
    events: StreamWriteEvent[],
    { files = [], attachments = [] }: { files?: OutputBlobWrite[]; attachments?: OutputBlobAttachment[] } = {},
  ): Promise<CommittedBatch> => {
    if (disposed || stopping) return Promise.reject(new Error("Stream persistence is closed"))
    if (unavailable) return Promise.reject(unavailable)
    const uniqueFiles = Array.from(new Map(files.map((file) => [file.id, file])).values())
    const uniqueAttachments = Array.from(new Map(attachments.map((attachment) => [attachment.id, attachment])).values())
    const bytes =
      Buffer.byteLength(JSON.stringify({ events, attachments: uniqueAttachments })) +
      uniqueFiles.reduce((total, file) => total + file.bytes, 0)
    if (
      queuedBytes + bytes > STREAM_PERSISTENCE_LIMITS.bytes ||
      queuedEvents + events.length > STREAM_PERSISTENCE_LIMITS.events
    ) {
      reportError()
      return Promise.reject(new Error("Stream persistence buffer limit exceeded"))
    }
    const batch = {
      id: crypto.randomUUID(),
      events: structuredClone(events),
      attachments: structuredClone(uniqueAttachments),
    }
    let resolveBatch: PendingBatch["resolve"] = () => {}
    let rejectBatch: PendingBatch["reject"] = () => {}
    const promise = new Promise<CommittedBatch>((resolve, reject) => {
      resolveBatch = resolve
      rejectBatch = reject
    })
    queue = queue.concat({
      batch,
      files: structuredClone(uniqueFiles),
      bytes,
      attempts: 0,
      failures: 0,
      filesWritten: false,
      promise,
      resolve: resolveBatch,
      reject: rejectBatch,
    })
    queuedBytes += bytes
    queuedEvents += events.length
    commitHead()
    return promise
  }
  const drain = async ({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<boolean> => {
    const watermark = queue.map(({ promise }) => promise)
    if (!watermark.length) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = Promise.allSettled(watermark).then(() => true)
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const drained = await Promise.race([completed, expired])
    clearTimeout(timer)
    return drained
  }
  const stopWorkerGracefully = async (): Promise<void> => {
    const current = worker
    if (!current) return
    workerNumber += 1
    worker = undefined
    ready = false
    running = false
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        current.removeEventListener("message", onMessage)
        resolve()
      }
      const onMessage = ({ data }: MessageEvent): void => {
        if (data?.type === "stopped") finish()
      }
      const timer = setTimeout(() => {
        current.terminate()
        finish()
      }, 1_000)
      current.addEventListener("message", onMessage)
      try {
        current.postMessage({ type: "stop" })
      } catch {
        current.terminate()
        finish()
      }
    })
  }

  const dispose = (): void => {
    disposed = true
    clearTimeout(retryTimer)
    stopWorker()
    settleReady()
    URL.revokeObjectURL(workerUrl)
  }
  const close = async (): Promise<void> => {
    if (disposed) return
    stopping = true
    const drained = await drain({ timeoutMs: 1_000 })
    if (!drained) reportError()
    await stopWorkerGracefully()
    dispose()
    const abandoned = queue
    queue = []
    queuedBytes = 0
    queuedEvents = 0
    abandoned.forEach(({ reject }) => {
      reject(new Error("Stream persistence stopped before commit"))
    })
  }
  const closeIfIdle = (): boolean => {
    if (disposed) return true
    if (queue.length || running || worker) return false
    stopping = true
    dispose()
    return true
  }

  readyWaitTimer = setTimeout(() => {
    readyWaitTimer = undefined
    if (ready || unavailable || disposed) return
    try {
      onReadyWaitExceeded?.()
    } catch {
      reportError()
    }
    resolveReady()
  }, readyWaitLimitMs)
  readyWaitTimer.unref()
  startWorker()

  return { submit, drain, close, closeIfIdle, ready: readyPromise }
}
