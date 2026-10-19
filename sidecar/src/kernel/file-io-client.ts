import type { FileIoError, FileIoMessage, FileIoRequest, FileIoTask } from "./file-io-protocol"
import { workerEntrypoint } from "./worker-entrypoint"
import { deferWorkerReply } from "./worker-reply"

type RefableWorker = Worker & { ref: () => void; unref: () => void }
type Completion = ReturnType<typeof Promise.withResolvers<unknown>>
type Entry = { task: FileIoTask; bytes: number; count: number; completion: Completion }
type WaitingEntry = Entry & { deadline: ReturnType<typeof setTimeout> }
type AppendTask = Extract<FileIoTask, { operation: "append" | "append-log" }>

export const fileIoQueueLimit = 256
export const fileIoByteLimit = 64 * 1024 * 1024
export const logIoByteLimit = 8 * 1024 * 1024
const batchByteLimit = 64 * 1024

/** Own the worker mailbox here so its memory and outstanding work stay bounded. */
export const createFileIoLane = ({
  maxBytes = fileIoByteLimit,
  batch = false,
  waitForCapacity = false,
  capacityTimeoutMs = 15_000,
  createWorker = startFileIoWorker,
} = {}) => {
  // Mutable lifecycle state belongs to this one worker and its bounded mailbox.
  let worker: RefableWorker | undefined
  let ready = false
  let closed = false
  let requestId = 0
  let entries: Entry[] = []
  let active: Entry | undefined
  let waiting: WaitingEntry[] = []
  let waitingBytes = 0
  let bytes = 0
  let dropped = 0
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let scheduled: ReturnType<typeof setImmediate> | undefined

  const stop = (error?: Error): void => {
    clearTimeout(startupTimer)
    clearImmediate(scheduled)
    scheduled = undefined
    const stoppedWorker = worker
    worker = undefined
    ready = false
    stoppedWorker?.terminate()
    const unfinished = getPendingEntries()
    waiting.forEach(({ deadline }) => {
      clearTimeout(deadline)
    })
    waiting = []
    waitingBytes = 0
    entries = []
    active = undefined
    bytes = 0
    if (!error) return
    deferWorkerReply(() =>
      unfinished.forEach(({ completion }) => {
        completion.reject(error)
      }),
    )
  }

  const handleMessage = ({ data }: MessageEvent<FileIoMessage>): void => {
    if (data.type === "ready") {
      clearTimeout(startupTimer)
      ready = true
      dispatch()
      return
    }
    if (data.requestId !== requestId || !active) return
    const finished = active
    active = undefined
    bytes -= finished.bytes
    deferWorkerReply(() => {
      if (data.error) finished.completion.reject(getError(data.error))
      else finished.completion.resolve(data.result)
    })
    admitWaiting()
    if (entries.length === 0) worker?.unref()
    dispatch()
  }

  const start = (): void => {
    try {
      worker = createWorker() as RefableWorker
    } catch {
      stop(new Error("File I/O worker could not start"))
      return
    }
    const startedWorker = worker
    startedWorker.addEventListener("close", () => {
      if (worker === startedWorker) stop(new Error("File I/O worker stopped unexpectedly"))
    })
    worker.ref()
    worker.onmessage = (event): void => {
      if (worker === startedWorker) handleMessage(event)
    }
    worker.onerror = (event): void => {
      event.preventDefault()
      if (worker === startedWorker) stop(new Error("File I/O worker stopped unexpectedly"))
    }
    startupTimer = setTimeout(() => stop(new Error("File I/O worker startup timed out")), 15_000)
    worker.postMessage({ type: "start" } satisfies FileIoRequest)
  }

  const dispatch = (): void => {
    scheduled = undefined
    if (active || entries.length === 0) return
    if (!worker) {
      start()
      return
    }
    if (!ready) return
    const [next, ...remaining] = entries
    if (!next) return
    active = next
    entries = remaining
    requestId += 1
    worker.ref()
    worker.postMessage({ ...next.task, requestId } satisfies FileIoRequest)
  }

  const getPendingEntries = (): Entry[] => [...(active ? [active] : []), ...entries, ...waiting]

  const hasCapacity = (size: number): boolean => {
    if (bytes + size <= maxBytes) return true
    // Caller limits own individual payloads; a large import runs alone instead of gaining a transport limit.
    return waitForCapacity && !active && entries.length === 0
  }

  const admitWaiting = (): void => {
    // This loop only moves the bounded mailbox's records, without copying their payloads.
    while (waiting.length > 0) {
      const [next, ...remaining] = waiting
      if (!next || !hasCapacity(next.bytes)) return
      clearTimeout(next.deadline)
      waiting = remaining
      waitingBytes -= next.bytes
      bytes += next.bytes
      entries = [...entries, next]
    }
  }

  const rejectCapacity = (): Promise<never> => {
    dropped += 1
    return Promise.reject(new Error("File I/O capacity exceeded"))
  }

  const waitForSpace = (task: FileIoTask, size: number): Promise<unknown> => {
    // Retain at most one extra byte budget, or one oversized caller payload beside ordinary work.
    const canWait = waitingBytes + size <= maxBytes || (waiting.length === 0 && bytes <= maxBytes)
    if (!canWait) return rejectCapacity()

    const completion = Promise.withResolvers<unknown>()
    const deadline = setTimeout(() => {
      waiting = waiting.filter((entry) => entry.completion !== completion)
      waitingBytes -= size
      dropped += 1
      deferWorkerReply(() => completion.reject(new Error("File I/O capacity wait timed out")))
      admitWaiting()
      scheduled ??= setImmediate(dispatch)
    }, capacityTimeoutMs)
    waiting = [...waiting, { task, bytes: size, count: 1, completion, deadline }]
    waitingBytes += size
    return completion.promise
  }

  const run = (task: FileIoTask): Promise<unknown> => {
    if (closed) return Promise.reject(new Error("File I/O is closed"))
    const size = getTaskBytes(task)
    const count = getPendingEntries().reduce((total, entry) => total + entry.count, 0)
    if (count >= fileIoQueueLimit) return rejectCapacity()
    if (waiting.length > 0 || !hasCapacity(size)) {
      if (!waitForCapacity) return rejectCapacity()
      return waitForSpace(task, size)
    }
    const batchIndex = batch ? getBatchIndex(entries, task) : -1
    const previous = entries[batchIndex]
    const combined = previous ? getAppendBatch(previous.task, task) : undefined
    bytes += size
    if (previous && combined) {
      const next = {
        task: combined,
        bytes: previous.bytes + size,
        count: previous.count + 1,
        completion: previous.completion,
      }
      entries = entries.map((entry, index) => (index === batchIndex ? next : entry))
      return previous.completion.promise
    }
    const completion = Promise.withResolvers<unknown>()
    entries = [...entries, { task, bytes: size, count: 1, completion }]
    scheduled ??= setImmediate(dispatch)
    return completion.promise
  }

  const flush = async (timeoutMs = 5000): Promise<void> => {
    const accepted = getPendingEntries()
    const expired = Promise.withResolvers<void>()
    const deadline = setTimeout(() => {
      const error = new Error("File I/O shutdown timed out")
      expired.reject(error)
      stop(error)
    }, timeoutMs)
    try {
      // Each operation reports its own failure. A barrier only waits for settlement.
      const settled = Promise.allSettled(accepted.map(({ completion }) => completion.promise)).then(() => undefined)
      await Promise.race([settled, expired.promise])
    } finally {
      clearTimeout(deadline)
    }
  }

  return {
    run,
    flush,
    close: async (timeoutMs = 5000): Promise<void> => {
      closed = true
      try {
        await flush(timeoutMs)
      } finally {
        stop()
      }
    },
    getStats: () => ({
      pending: getPendingEntries().reduce((total, entry) => total + entry.count, 0),
      bytes: bytes + waitingBytes,
      dropped,
    }),
  }
}

const getTaskBytes = (task: FileIoTask): number => {
  if (task.operation !== "write" && task.operation !== "append" && task.operation !== "append-log") return 0
  return typeof task.args.content === "string" ? Buffer.byteLength(task.args.content) : task.args.content.byteLength
}

const isAppend = (task: FileIoTask): task is AppendTask =>
  task.operation === "append" || task.operation === "append-log"

const getBatchIndex = (entries: Entry[], next: FileIoTask): number => {
  if (!isAppend(next)) return -1
  return entries.reduce((found, entry, index) => {
    if (!isAppend(entry.task)) return -1
    if (entry.task.args.root !== next.args.root || entry.task.args.path !== next.args.path) return found
    return index
  }, -1)
}

const getAppendBatch = (previous: FileIoTask, next: FileIoTask): AppendTask | undefined => {
  if (!isAppend(previous) || !isAppend(next) || previous.operation !== next.operation) return
  if (previous.args.root !== next.args.root || previous.args.path !== next.args.path) return
  if (previous.args.maxBytes !== next.args.maxBytes) return
  if (getTaskBytes(previous) + getTaskBytes(next) > batchByteLimit) return
  if (previous.operation === "append-log" && next.operation === "append-log") {
    if (previous.args.retainedGenerations !== next.args.retainedGenerations) return
    return {
      ...previous,
      args: { ...previous.args, content: Buffer.concat([previous.args.content, next.args.content]) },
    }
  }
  if (previous.operation !== "append" || next.operation !== "append") return
  if (previous.args.mode !== next.args.mode) return
  const content = Buffer.concat([Buffer.from(previous.args.content), Buffer.from(next.args.content)])
  return { ...previous, args: { ...previous.args, content } }
}

const getError = ({ name, message, code }: FileIoError): Error =>
  Object.assign(new Error(message), { name, ...(code ? { code } : {}) })

const startFileIoWorker = (): Worker =>
  new Worker(workerEntrypoint(new URL("./file-io-worker.ts", import.meta.url), "./file-io-worker-entry.ts"), {
    smol: true,
    ref: false,
  })
