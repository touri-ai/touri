import { workerEntrypoint } from "../../kernel/worker-entrypoint"
import { deferWorkerReply } from "../../kernel/worker-reply"
import type { WorkerError, WriteCommand, WriterMessage, WriterRequest } from "./store-protocol"

const writerStartupTimeoutMs = 15_000

/** Reject uncertain in-flight writes; later commands reopen the durable database. */
export const createAuthWriter = async (filename: string, createWorker = startAuthWriterWorker) => {
  // Each store owns one writer generation; concurrent recovery shares its startup.
  let current = await startAuthWriter(filename, createWorker)
  let restarting: Promise<AuthWriter> | undefined
  let closed = false
  const ensureWriter = async (): Promise<AuthWriter> => {
    if (closed) throw new Error("Authentication writer is closed")
    if (!current.isStopped()) return current
    restarting ??= startAuthWriter(filename, createWorker)
      .then((writer) => {
        current = writer
        return writer
      })
      .finally(() => {
        restarting = undefined
      })
    return restarting
  }
  return {
    write: async (command: WriteCommand): Promise<unknown> => (await ensureWriter()).write(command),
    close: async (): Promise<void> => {
      closed = true
      await restarting?.catch(() => undefined)
      await current.close()
    },
  }
}

type AuthWriter = {
  write: (command: WriteCommand) => Promise<unknown>
  isStopped: () => boolean
  close: () => Promise<void>
}
type RefableWorker = Worker & { ref: () => void; unref: () => void }

const getWorkerError = ({ name, message, code }: WorkerError): Error =>
  Object.assign(new Error(message), { name, ...(code ? { code } : {}) })

const startAuthWriter = async (filename: string, createWorker: () => Worker): Promise<AuthWriter> => {
  const worker = createWorker() as RefableWorker
  worker.ref()
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let requestId = 0
  let readyResolve: () => void = () => {}
  let readyReject: (error: Error) => void = () => {}
  let stoppedResolve: () => void = () => {}
  let stoppedByError = false
  let closing = false
  let closePromise: Promise<void> | undefined
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const stopped = new Promise<void>((resolve) => {
    stoppedResolve = resolve
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
  worker.onmessage = ({ data }: MessageEvent<WriterMessage>): void => {
    if (data.type === "ready") {
      deferWorkerReply(readyResolve)
      return
    }
    if (data.type === "startup-error") {
      deferWorkerReply(() => readyReject(getWorkerError(data.error)))
      return
    }
    if (data.type === "stopped") {
      deferWorkerReply(stoppedResolve)
      return
    }
    const result = pending.get(data.requestId)
    if (!result) return
    pending.delete(data.requestId)
    deferWorkerReply(() => {
      if (data.error) result.reject(getWorkerError(data.error))
      else result.resolve(data.result)
    })
    if (pending.size === 0 && !closing) worker.unref()
  }
  const fail = (): void => {
    if (stoppedByError) return
    const error = new Error("Authentication writer stopped unexpectedly")
    stoppedByError = true
    worker.terminate()
    deferWorkerReply(() => readyReject(error))
    rejectPending(error)
    deferWorkerReply(stoppedResolve)
  }
  worker.onerror = (event): void => {
    event.preventDefault()
    fail()
  }
  worker.addEventListener("close", () => {
    if (!closing) fail()
    deferWorkerReply(stoppedResolve)
  })
  worker.postMessage({ type: "start", filename } satisfies WriterRequest)
  const startupTimeout = setTimeout(
    () => readyReject(new Error("Authentication writer startup timed out")),
    writerStartupTimeoutMs,
  )
  startupTimeout.unref()
  try {
    await ready
    worker.unref()
  } catch (error) {
    worker.terminate()
    throw error
  } finally {
    clearTimeout(startupTimeout)
  }

  const write = (command: WriteCommand): Promise<unknown> => {
    if (stoppedByError || closing) return Promise.reject(new Error("Authentication writer is unavailable"))
    worker.ref()
    const id = ++requestId
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
    worker.postMessage({ ...command, requestId: id } satisfies WriterRequest)
    return result
  }

  return {
    write,
    isStopped: () => stoppedByError,
    close: () => {
      closePromise ??= (async () => {
        closing = true
        if (stoppedByError) {
          worker.terminate()
          return
        }
        worker.ref()
        worker.postMessage({ type: "stop" } satisfies WriterRequest)
        const deadline = setTimeout(() => {
          stoppedResolve()
          worker.terminate()
        }, 5000)
        await stopped
        clearTimeout(deadline)
        worker.terminate()
      })()
      return closePromise
    },
  }
}

const startAuthWriterWorker = (): Worker =>
  new Worker(workerEntrypoint(new URL("./store-writer.ts", import.meta.url), "./auth-writer-worker-entry.ts"), {
    smol: true,
    ref: false,
  })
