import { afterEach, expect, test } from "bun:test"
import type { PerformanceStageRunner } from "../../src/kernel/performance"
import { startLineReader } from "../../src/runtime/provider-io"

// Reader lifetimes are collected here so a failed assertion still stops the stream.
let stopReaders: Array<() => void> = []
afterEach(() => {
  stopReaders.forEach((stop) => {
    stop()
  })
  stopReaders = []
})

const getStream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

test("Slow lines yield after the elapsed budget so cancellation can stop the remaining batch", async () => {
  let elapsed = 0
  let received: Array<string> = []
  const stop = startLineReader({
    stream: getStream("one\ntwo\nthree\nfour\nfive\n"),
    onLine: (line) => {
      received = [...received, line]
      elapsed += 3
    },
    onError: (error) => {
      throw error
    },
    now: () => elapsed,
  })
  stopReaders = [...stopReaders, stop]

  await yieldToEventLoop()
  stop()
  await yieldToEventLoop()

  expect(received).toEqual(["one", "two", "three"])
  expect(elapsed).toBe(9)
})

test("Fast lines still yield after sixteen lines and retain their order and final unterminated line", async () => {
  const lines = Array.from({ length: 35 }, (_, index) => String(index))
  let received: Array<string> = []
  let batches: Array<number> = []
  const runStage: PerformanceStageRunner = (_stage, action, input) => {
    const before = received.length
    const result = action(input as Parameters<typeof action>[0])
    batches = [...batches, received.length - before]
    return result
  }
  const stop = startLineReader({
    stream: getStream(lines.join("\n")),
    onLine: (line) => {
      received = [...received, line]
    },
    onError: (error) => {
      throw error
    },
    runStage,
    now: () => 0,
  })
  stopReaders = [...stopReaders, stop]

  await yieldToEventLoop()
  expect(received).toEqual(lines.slice(0, 16))
  await yieldToEventLoop()
  await yieldToEventLoop()
  await yieldToEventLoop()

  expect(received).toEqual(lines)
  expect(batches.filter((size) => size > 0)).toEqual([16, 16, 2])
})
