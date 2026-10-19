import type { FileIoError, FileIoMessage, FileIoRequest, FileIoTask } from "./file-io-protocol"
import type { FileWrite } from "./files"
import { workerEntrypoint } from "./worker-entrypoint"

type RefableWorker = Worker & { ref: () => void; unref: () => void }

const createFileIo = () => {
  let worker: RefableWorker | undefined
  let starting: Promise<void> | undefined
  let ready = false
  let requestId = 0
  let readyReject: (error: Error) => void = () => {}
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const rejectPending = (error: Error): void => {
    pending.forEach(({ reject }) => {
      reject(error)
    })
    pending.clear()
  }

  const ensureStarted = (): Promise<void> => {
    if (ready) return Promise.resolve()
    if (starting) return starting
    starting = new Promise<void>((resolve, reject) => {
      readyReject = reject
      worker = new Worker(
        workerEntrypoint(
          new URL("./file-io-worker.ts", import.meta.url),
          new URL("../../../sidecar-file-io-worker.ts", import.meta.url),
        ),
        { smol: true, ref: false },
      ) as RefableWorker
      worker.onmessage = ({ data }: MessageEvent<FileIoMessage>): void => {
        if ("type" in data && data.type === "ready") {
          ready = true
          worker?.unref()
          resolve()
          return
        }
        if (!("requestId" in data)) return
        const result = pending.get(data.requestId)
        if (!result) return
        pending.delete(data.requestId)
        if (data.error) result.reject(toError(data.error))
        else result.resolve(data.result)
        if (pending.size === 0) worker?.unref()
      }
      worker.onerror = (event): void => {
        event.preventDefault()
        const detail = event.message.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/]+[\\/])*[^\s\\/]+/g, "<path>").slice(0, 160)
        const error = new Error(
          detail ? `File I/O worker stopped unexpectedly: ${detail}` : "File I/O worker stopped unexpectedly",
        )
        ready = false
        worker = undefined
        readyReject(error)
        rejectPending(error)
      }
      worker.postMessage({ type: "start" } satisfies FileIoRequest)
    }).finally(() => {
      starting = undefined
    })
    return starting
  }

  return async (task: FileIoTask): Promise<unknown> => {
    const started = ensureStarted()
    worker?.ref()
    await started
    if (!worker) throw new Error("File I/O worker is not available")
    worker.ref()
    const id = ++requestId
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
    worker.postMessage({ ...task, requestId: id } satisfies FileIoRequest)
    return result
  }
}

const toError = ({ name, message, code }: FileIoError): Error =>
  Object.assign(new Error(message), { name, ...(code ? { code } : {}) })

const runFileIoTask = createFileIo()

export const writePrivateFileAsync = (args: FileWrite): Promise<void> =>
  runFileIoTask({ operation: "write", args }).then(() => undefined)

export const appendPrivateFileAsync = (args: FileWrite & { maxBytes?: number }): Promise<void> =>
  runFileIoTask({ operation: "append", args }).then(() => undefined)

export const ensurePrivateDirectoryAsync = (args: { root: string; path?: string; mode?: number }): Promise<void> =>
  runFileIoTask({ operation: "ensure-directory", args }).then(() => undefined)

export const removePrivateFileAsync = (args: { root: string; path: string }): Promise<void> =>
  runFileIoTask({ operation: "remove", args }).then(() => undefined)

export const movePrivateFileAsync = (args: { root: string; from: string; to: string }): Promise<void> =>
  runFileIoTask({ operation: "move", args }).then(() => undefined)

export const privateFileExistsAsync = (args: { root: string; path: string }): Promise<boolean> =>
  runFileIoTask({ operation: "exists", args }).then(Boolean)

export const prepareDatabaseFileAsync = (args: { root: string; path: string }): Promise<string> =>
  runFileIoTask({ operation: "prepare-database", args }).then((filename) => String(filename))

export const appendLogFileAsync = (args: {
  root: string
  path: string
  content: Uint8Array
  maxBytes: number
  retainedGenerations: number
}): Promise<void> => runFileIoTask({ operation: "append-log", args }).then(() => undefined)

export const createWorkspaceDirectoryAsync = (args: {
  root: string
  path: string
  identity: { dev: number; ino: number }
}): Promise<void> => runFileIoTask({ operation: "create-workspace-directory", args }).then(() => undefined)

export const rotatePrivateDirectoryAsync = (args: {
  root: string
  directory: string
  retainedFiles: number
}): Promise<void> => runFileIoTask({ operation: "rotate-directory", args }).then(() => undefined)

export const removePrivateFileIfMatchesAsync = (args: { root: string; path: string; content: string }): Promise<void> =>
  runFileIoTask({ operation: "remove-if-matches", args }).then(() => undefined)

export const replacePrivateSymlinkAsync = (args: { root: string; path: string; target: string }): Promise<void> =>
  runFileIoTask({ operation: "replace-symlink", args }).then(() => undefined)

export const removeBotHomeDirectoryAsync = (args: { root: string; path: string; botId: string }): Promise<void> =>
  runFileIoTask({ operation: "remove-bot-home", args }).then(() => undefined)
