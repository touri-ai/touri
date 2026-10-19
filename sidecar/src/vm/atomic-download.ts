import { workerEntrypoint } from "../kernel/worker-entrypoint"
import { deferWorkerReply } from "../kernel/worker-reply"

type DownloadMessage =
  | { type: "ready" }
  | { type?: undefined; requestId: number; error?: { name: string; message: string; code?: string } }
type DownloadCommand = "start" | "chunk" | "finish" | "abort"

const workerError = (error: { name: string; message: string; code?: string }): Error =>
  Object.assign(new Error(error.message), { name: error.name, ...(error.code ? { code: error.code } : {}) })

/** Stream a downloaded snapshot through a worker so disk writes and fsync never block the server loop. */
export const atomicDownload = async (response: Response, path: string): Promise<void> => {
  if (!response.ok || !response.body || path.includes("\0")) throw new Error("Snapshot inválido")
  const worker = new Worker(
    workerEntrypoint(new URL("./atomic-download-worker.ts", import.meta.url), "./atomic-download-worker-entry.ts"),
    { smol: true },
  )
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
  worker.onmessage = ({ data }: MessageEvent<DownloadMessage>): void => {
    if (data.type === "ready") {
      deferWorkerReply(readyResolve)
      return
    }
    const request = pending.get(data.requestId)
    if (!request) return
    pending.delete(data.requestId)
    deferWorkerReply(() => {
      if (data.error) request.reject(workerError(data.error))
      else request.resolve()
    })
  }
  worker.onerror = (event): void => {
    event.preventDefault()
    const error = new Error("Snapshot writer stopped unexpectedly")
    deferWorkerReply(() => readyReject(error))
    rejectPending(error)
  }
  const request = (type: DownloadCommand, content?: Uint8Array): Promise<void> => {
    const id = ++requestId
    const result = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }))
    if (type === "start") worker.postMessage({ type, requestId: id, path })
    else if (type === "chunk" && content) worker.postMessage({ type, requestId: id, content }, [content.buffer])
    else worker.postMessage({ type, requestId: id })
    return result
  }
  const reader = response.body.getReader()
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
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
    worker.terminate()
  }
}
