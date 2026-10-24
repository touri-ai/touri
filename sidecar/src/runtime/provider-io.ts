import type { Kernel } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"

export type ChildProcess = Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>
const PROVIDER_FRAME_BATCH_SIZE = 16
const PROVIDER_FRAME_BATCH_MS = 8

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Observe diagnostics as they arrive, including writes split across chunks. */
export const readProviderStderr = async (stream: ReadableStream<Uint8Array>, observe: (text: string) => void) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      text = (text + decoder.decode(chunk.value, { stream: !chunk.done })).slice(-65_536)
      observe(text)
      if (chunk.done) return text
    }
  } finally {
    reader.releaseLock()
  }
}

const pendingWrites = new WeakMap<WritableStream<Uint8Array>, Promise<void>>()

/** Writes one JSON line; concurrent writers to the same stdin are queued, never rejected as locked. */
export const writeLine = ({ stdin, value }: { stdin: WritableStream<Uint8Array>; value: unknown }): Promise<void> => {
  const write = async () => {
    const writer = stdin.getWriter()
    try {
      await writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
    } finally {
      writer.releaseLock()
    }
  }
  const next = (pendingWrites.get(stdin) ?? Promise.resolve()).catch(() => undefined).then(write)
  pendingWrites.set(stdin, next)
  return next
}

export const startLineReader = ({
  stream,
  onLine,
  onError,
  runStage,
  waitForDispatch,
  now = performance.now.bind(performance),
}: {
  stream: ReadableStream<Uint8Array>
  onLine: (line: string) => void
  onError: (error: Error) => void
  runStage?: PerformanceStageRunner
  waitForDispatch?: () => Promise<void> | undefined
  now?: () => number
}): (() => void) & { done: Promise<void> } => {
  let stopped = false
  type Slice = { offset: number; processed: number; elapsedMs: number }
  const processLines = ({ buffer, offset, processed, elapsedMs }: Slice & { buffer: string }): Slice => {
    const startedAt = now()
    // Parser cursors stay local so each slice bounds extraction and dispatch together.
    let cursor = offset
    let lines = processed
    while (!stopped && lines < PROVIDER_FRAME_BATCH_SIZE) {
      const newline = buffer.indexOf("\n", cursor)
      if (newline < 0) break

      const line = buffer.slice(cursor, newline).trim()
      cursor = newline + 1
      lines += 1
      if (line) onLine(line)
      if (elapsedMs + now() - startedAt >= PROVIDER_FRAME_BATCH_MS) break
    }
    return { offset: cursor, processed: lines, elapsedMs: elapsedMs + now() - startedAt }
  }
  const processBatch = (input: Slice & { buffer: string }): Slice => {
    return runStage ? runStage("provider_frame_batch", processLines, input) : processLines(input)
  }
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let processed = 0
    let elapsedMs = 0
    try {
      while (!stopped) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let offset = 0
        while (!stopped && buffer.indexOf("\n", offset) >= 0) {
          // Let an acknowledged replay drain before accepting another live batch.
          await waitForDispatch?.()
          if (stopped) break
          const slice = processBatch({ buffer, offset, processed, elapsedMs })
          offset = slice.offset
          processed = slice.processed
          elapsedMs = slice.elapsedMs
          if (processed >= PROVIDER_FRAME_BATCH_SIZE || elapsedMs >= PROVIDER_FRAME_BATCH_MS) {
            await yieldToEventLoop()
            processed = 0
            elapsedMs = 0
          }
        }
        buffer = buffer.slice(offset)
      }
      await waitForDispatch?.()
      const tail = buffer.trim()
      if (!stopped && tail) onLine(tail)
    } catch (error) {
      if (!stopped) onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
    }
  })()
  return Object.assign(
    () => {
      stopped = true
    },
    { done },
  )
}
