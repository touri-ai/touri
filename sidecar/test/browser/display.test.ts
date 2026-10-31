import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { startBrowserDisplay } from "../../src/browser/display"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("display startup waits for the newline before closing the readiness pipe", async () => {
  const newline = Promise.withResolvers<void>()
  const requestedNewline = Promise.withResolvers<void>()
  const chunks = ["24"][Symbol.iterator]()
  const stdout = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const next = chunks.next()
        if (!next.done) {
          controller.enqueue(new TextEncoder().encode(next.value))
          return
        }
        requestedNewline.resolve()
        await newline.promise
        controller.enqueue(new TextEncoder().encode("\n"))
      },
    },
    { highWaterMark: 0 },
  )
  const fixture = await getDisplayFixture(stdout)

  const started = fixture.start()
  const first = await Promise.race([
    started.then(() => "ready"),
    requestedNewline.promise.then(() => "newline requested"),
  ])
  newline.resolve()
  const display = await started

  expect(first).toBe("newline requested")
  expect(display?.env.DISPLAY).toBe(":24")
  expect(fixture.signals.size).toBe(0)
})

test.each([[["1", "2", "\n"]], [["12\n"]]])(
  "display readiness accepts complete digits across chunks: %j",
  async (chunks) => {
    const fixture = await getDisplayFixture(getChunkStream(chunks))

    const display = await fixture.start()

    expect(display?.env.DISPLAY).toBe(":12")
    expect(fixture.signals.size).toBe(0)
  },
)

test.each([[["12"]], [["\n"]], [["123456\n"]], [["12\nextra"]], [["invalid"]]])(
  "invalid or incomplete readiness stops the owned display: %j",
  async (chunks) => {
    const fixture = await getDisplayFixture(getChunkStream(chunks))

    const display = await fixture.start()

    expect(display).toBeNull()
    expect(Array.from(fixture.signals)).toEqual(["SIGTERM"])
  },
)

const getChunkStream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      chunks.forEach((chunk) => {
        controller.enqueue(new TextEncoder().encode(chunk))
      })
      controller.close()
    },
  })

const getDisplayFixture = async (stdout: ReadableStream<Uint8Array>) => {
  const root = await mkdtemp(join(tmpdir(), "touri-display-readiness-"))
  const runtime = createKernel({ appData: root })
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  const signals = new Set<string>()
  const kernel: Kernel = Object.assign({}, runtime.kernel, {
    spawnTree: () => ({
      success: true as const,
      pid: 1,
      pgid: 1,
      stdout,
      stderr: new Blob([]).stream(),
      stdin: new WritableStream<Uint8Array>(),
      extra: [],
      exited: exited.promise,
      kill: (signal: string) => {
        signals.add(signal)
        exited.resolve({ code: null, signal })
      },
    }),
  })
  const start = async () => {
    const display = await startBrowserDisplay(kernel, {})
    if (display) cleanups.add(display.stop)
    return display
  }
  cleanups.add(async () => {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })

  return { start, signals }
}
