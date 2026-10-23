import type { SQLQueryBindings } from "bun:sqlite"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

type ReadQuery = { sql: string; bindings: SQLQueryBindings[] }
export type MessageReferences = { threadId: string; messageId: string; attachmentIds: string[] }
type MessageReply = { body: Uint8Array; references: MessageReferences[] }
type ReadProcess = Bun.Subprocess<"pipe", "pipe", "ignore">

export const createStoreReader = (filename: string, onReady?: (pid: number) => void) => {
  // Each request owns a process: SIGKILL also interrupts native SQLite, unlike a JS waiter.
  const pending = new Map<ReadProcess, () => void>()
  let disposed = false

  const getResult = async <Value>(query: ReadQuery, signal: AbortSignal, messages = false): Promise<Value> => {
    signal.throwIfAborted()
    if (disposed || pending.size >= 2) throw new Error("STORE_READ_CAPACITY")

    const devArgs = Bun.isStandaloneExecutable ? [] : [fileURLToPath(new URL("./read-process.ts", import.meta.url))]
    const child = Bun.spawn([process.execPath, ...devArgs, "store-read"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TOURI_APP_DATA: dirname(filename) },
    })
    // Only this request owns its cancellation reason and process lifecycle.
    let abortReason: Error | undefined
    const kill = (code: string): void => {
      abortReason = new Error(code)
      child.kill("SIGKILL")
    }
    const abort = (): void => kill("STORE_READ_ABORTED")
    const timer = setTimeout(() => kill("STORE_READ_TIMEOUT"), 15_000)
    pending.set(child, abort)
    signal.addEventListener("abort", abort, { once: true })

    try {
      child.stdin.write(JSON.stringify({ filename, query, messages }))
      await child.stdin.end()
      const response = getProcessReply(child.stdout, messages, () => onReady?.(child.pid))
      const [value, code] = await Promise.all([response, child.exited])
      if (abortReason) throw abortReason
      if (code !== 0) throw new Error("STORE_READ_FAILED")

      return value as Value
    } catch {
      child.kill("SIGKILL")
      await child.exited
      throw abortReason ?? new Error("STORE_READ_FAILED")
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      pending.delete(child)
    }
  }

  const dispose = (): void => {
    disposed = true
    pending.forEach((abort) => {
      abort()
    })
  }

  return {
    getRows: <Row>(query: ReadQuery, signal: AbortSignal): Promise<Row[]> => getResult<Row[]>(query, signal),
    getMessages: (
      query: ReadQuery & { activeLeafId: string | null; reverse?: boolean },
      signal: AbortSignal,
    ): Promise<MessageReply> => getResult<MessageReply>(query, signal, true),
    dispose,
  }
}

const getProcessReply = async (stdout: ReadableStream<Uint8Array>, messages: boolean, onReady: () => void) => {
  const reader = stdout.getReader()
  const first = await reader.read()
  if (first.done || first.value[0] !== 82) throw new Error("STORE_READ_FAILED")
  onReady()

  const remaining = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.value.byteLength > 1) controller.enqueue(first.value.subarray(1))
    },
    async pull(controller) {
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel: () => reader.cancel(),
  })
  if (!messages) return getRowsFromStream(remaining)

  const bytes = new Uint8Array(await new Response(remaining).arrayBuffer())
  if (bytes.byteLength < 4) throw new Error("STORE_READ_FAILED")
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)
  if (headerLength > 8 * 1024 * 1024 || headerLength + 4 > bytes.byteLength) throw new Error("STORE_READ_FAILED")
  // Decode reference frames in small chunks too; a large attachment list is still historical JSON.
  let offset = 4
  const header = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= headerLength + 4) return controller.close()

      const end = Math.min(offset + 16_384, headerLength + 4)
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
    },
  })
  const references = (await getRowsFromStream(header)) as MessageReferences[]

  return { references, body: bytes.subarray(headerLength + 4) }
}

const getRowsFromStream = async (stream: ReadableStream<Uint8Array>): Promise<unknown[]> => {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  // Framing and rows are request-local; each parse is bounded and batches yield to live I/O.
  const rows: unknown[] = []
  let tail = ""
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break

    bytes += Buffer.byteLength(next.value)
    if (bytes > 64 * 1024 * 1024) throw new Error("STORE_READ_LIMIT")
    const lines = (tail + next.value).split("\n")
    tail = lines.pop() ?? ""
    if (tail.length > 512 * 1024) throw new Error("STORE_READ_LIMIT")
    for (let offset = 0; offset < lines.length; offset += 32) {
      lines.slice(offset, offset + 32).forEach((line) => {
        if (!line || line.length > 512 * 1024) throw new Error("STORE_READ_LIMIT")
        rows.push(JSON.parse(line))
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  if (tail) throw new Error("STORE_READ_FAILED")

  return rows
}
