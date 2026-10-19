import { createAtomicDownloadWriter } from "./atomic-download-core"

type DownloadRequest =
  | { type: "start"; requestId: number; path: string }
  | { type: "chunk"; requestId: number; content: Uint8Array }
  | { type: "finish"; requestId: number }
  | { type: "abort"; requestId: number }

type DownloadMessage = { type: "ready" } | { requestId: number; error?: WorkerError }
type WorkerError = { name: string; message: string; code?: string }

let writer: ReturnType<typeof createAtomicDownloadWriter> | undefined

self.onmessage = ({ data }: MessageEvent<DownloadRequest>): void => {
  if (data.type === "start") {
    try {
      writer = createAtomicDownloadWriter(data.path)
      self.postMessage({ requestId: data.requestId } satisfies DownloadMessage)
    } catch (error) {
      self.postMessage({ requestId: data.requestId, error: toWorkerError(error) } satisfies DownloadMessage)
    }
    return
  }
  try {
    const current = writer
    if (!current) throw new Error("Gravação de snapshot indisponível")
    if (data.type === "chunk") current.write(data.content)
    else if (data.type === "finish") {
      current.finish()
      writer = undefined
    } else {
      current.abort()
      writer = undefined
    }
    self.postMessage({ requestId: data.requestId } satisfies DownloadMessage)
  } catch (error) {
    writer?.abort()
    writer = undefined
    self.postMessage({ requestId: data.requestId, error: toWorkerError(error) } satisfies DownloadMessage)
  }
}

self.postMessage({ type: "ready" } satisfies DownloadMessage)

const toWorkerError = (error: unknown): WorkerError => {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) }
  const code = (error as Error & { code?: unknown }).code
  return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) }
}
