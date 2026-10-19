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
  now = performance.now.bind(performance),
}: {
  stream: ReadableStream<Uint8Array>
  onLine: (line: string) => void
  onError: (error: Error) => void
  runStage?: PerformanceStageRunner
  now?: () => number
}): (() => void) => {
  let stopped = false
  const processLines = ({ buffer, offset }: { buffer: string; offset: number }): number => {
    const startedAt = now()
    // Parser cursors stay local so each slice bounds extraction and dispatch together.
    let cursor = offset
    let processed = 0
    while (!stopped && processed < PROVIDER_FRAME_BATCH_SIZE) {
      const newline = buffer.indexOf("\n", cursor)
      if (newline < 0) break

      const line = buffer.slice(cursor, newline).trim()
      cursor = newline + 1
      processed += 1
      if (line) onLine(line)
      if (now() - startedAt >= PROVIDER_FRAME_BATCH_MS) break
    }
    return cursor
  }
  const processBatch = (input: { buffer: string; offset: number }): number => {
    return runStage ? runStage("provider_frame_batch", processLines, input) : processLines(input)
  }
  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (!stopped) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let offset = 0
        while (!stopped) {
          const next = processBatch({ buffer, offset })
          if (next === offset) break

          offset = next
          await yieldToEventLoop()
        }
        buffer = buffer.slice(offset)
      }
      const tail = buffer.trim()
      if (!stopped && tail) onLine(tail)
    } catch (error) {
      if (!stopped) onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
    }
  })()
  return () => {
    stopped = true
  }
}
