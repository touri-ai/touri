import type { Kernel } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"

export type ChildProcess = Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>
const PROVIDER_FRAME_BATCH_SIZE = 64

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
}: {
  stream: ReadableStream<Uint8Array>
  onLine: (line: string) => void
  onError: (error: Error) => void
  runStage?: PerformanceStageRunner
}): (() => void) => {
  let stopped = false
  const processLines = ({ values }: { values: Array<string> }): void => {
    for (const value of values) {
      if (stopped) break
      onLine(value)
    }
  }
  const processBatch = (values: Array<string>): void => {
    const input = { values }
    if (runStage) runStage("provider_frame_batch", processLines, input)
    else processLines(input)
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
        let processed = 0
        let lines: Array<string> = []
        let newline = buffer.indexOf("\n", offset)
        while (newline >= 0 && !stopped) {
          const line = buffer.slice(offset, newline).trim()
          offset = newline + 1
          if (line) lines.push(line)
          processed += 1
          if (processed === PROVIDER_FRAME_BATCH_SIZE) {
            processBatch(lines)
            lines = []
            processed = 0
            await yieldToEventLoop()
          }
          newline = buffer.indexOf("\n", offset)
        }
        if (lines.length) processBatch(lines)
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
