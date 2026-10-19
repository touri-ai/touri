import { workerEntrypoint } from "../kernel/worker-entrypoint"
import { deferWorkerReply } from "../kernel/worker-reply"

type DownloadMessage =
  | { type: "ready" }
  | { type?: undefined; requestId: number; error?: { name: string; message: string; code?: string } }
type DownloadCommand = "start" | "chunk" | "finish" | "abort"

const getWorkerError = (error: { name: string; message: string; code?: string }): Error =>
  Object.assign(new Error(error.message), { name: error.name, ...(error.code ? { code: error.code } : {}) })

/** Stream a downloaded snapshot through a worker so disk writes and fsync never block the server loop. */
export const atomicDownload = async (
  response: Response,
  path: string,
  { createWorker = startDownloadWorker, startupTimeoutMs = 15_000 } = {},
): Promise<void> => {
  if (!response.ok || !response.body || path.includes("\0")) throw new Error("Snapshot inválido")
  const worker = createWorker()
  const reader = response.body.getReader()
  // Failure state belongs to this one download and prevents sends to a terminated worker.
  let failure: Error | undefined
  let closed = false
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  let requestId = 0
  let readyResolve: () => void = () => {}
  let readyReject: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const rejectPending = (error: Error): void => {
    const rejected = Array.from(pending.values())
    deferWorkerReply(() =>
      rejected.forEach(({ reject }) => {
        reject(error)
      }),
    )
    pending.clear()
  }
  const stop = (error: Error): void => {
    if (closed || failure) return
    failure = error
    clearTimeout(startupTimer)
    deferWorkerReply(() => readyReject(error))
    rejectPending(error)
    void reader.cancel().catch(() => {})
    worker.terminate()
  }
  const startupTimer = setTimeout(() => stop(new Error("Snapshot writer startup timed out")), startupTimeoutMs)
  worker.addEventListener("close", () => stop(new Error("Snapshot writer stopped unexpectedly")))
  worker.onmessage = ({ data }: MessageEvent<DownloadMessage>): void => {
    if (data.type === "ready") {
      clearTimeout(startupTimer)
      deferWorkerReply(readyResolve)
      return
    }
    const request = pending.get(data.requestId)
    if (!request) return
    pending.delete(data.requestId)
    deferWorkerReply(() => {
      if (data.error) request.reject(getWorkerError(data.error))
      else request.resolve()
    })
  }
  worker.onerror = (event): void => {
    event.preventDefault()
    stop(new Error("Snapshot writer stopped unexpectedly"))
  }
  const request = (type: DownloadCommand, content?: Uint8Array): Promise<void> => {
    if (failure) return Promise.reject(failure)
    const id = ++requestId
    const result = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }))
    if (type === "start") worker.postMessage({ type, requestId: id, path })
    else if (type === "chunk" && content) worker.postMessage({ type, requestId: id, content }, [content.buffer])
    else worker.postMessage({ type, requestId: id })
    return result
  }
  let started = false
  let finished = false
  try {
    await ready
    await request("start")
    started = true
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const content = new Uint8Array(next.value.byteLength)
      content.set(next.value)
      await request("chunk", content)
    }
    await request("finish")
    finished = true
  } catch (error) {
    if (started && !finished) await request("abort").catch(() => {})
    throw error
  } finally {
    closed = true
    clearTimeout(startupTimer)
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
    worker.terminate()
  }
}

const startDownloadWorker = (): Worker =>
  new Worker(
    workerEntrypoint(new URL("./atomic-download-worker.ts", import.meta.url), "./atomic-download-worker-entry.ts"),
    { smol: true },
  )
