import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCdpClient } from "../../src/browser/cdp"
import { createChromeLauncher } from "../../src/browser/launcher"
import { createKernel } from "../../src/kernel"

const setChromeBinary = (binary: string): (() => void) => {
  const previousBinary = process.env.TOURI_CHROME_BIN
  process.env.TOURI_CHROME_BIN = binary

  return () => {
    if (previousBinary === undefined) delete process.env.TOURI_CHROME_BIN
    else process.env.TOURI_CHROME_BIN = previousBinary
  }
}

let root: string | null = null
let runtime: ReturnType<typeof createKernel> | null = null
let launcher: ReturnType<typeof createChromeLauncher> | null = null
let restoreChromeBinary = () => {}

afterEach(async () => {
  await launcher?.stop()
  runtime?.stop()
  restoreChromeBinary()
  if (root) rmSync(root, { recursive: true, force: true })
})

test("Chrome launcher preserves the CDP client's default timeout for startup calls", async () => {
  root = mkdtempSync(join(tmpdir(), "touri-chrome-launcher-timeout-"))
  runtime = createKernel({ appData: root })
  restoreChromeBinary = setChromeBinary("chrome-test-binary")
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  const output = { current: null as ReadableStreamDefaultController<Uint8Array> | null }
  const timeouts: Array<number | undefined> = []
  runtime.kernel.spawnTree = () => ({
    success: true,
    target: "local",
    pid: 1,
    pgid: 1,
    stdout: new ReadableStream({ start: (controller) => controller.close() }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    stdin: new WritableStream(),
    extra: [
      { read: null, write: new WritableStream() },
      {
        read: new ReadableStream<Uint8Array>({ start: (controller) => (output.current = controller) }),
        write: null,
      },
    ],
    exited: exited.promise,
    kill: (signal) => exited.resolve({ code: null, signal }),
  })
  const currentRuntime = runtime
  const currentLauncher = createChromeLauncher({
    kernel: currentRuntime.kernel,
    createClient: (options) => {
      timeouts.push(options.timeoutMs)
      const client = createCdpClient(options)
      queueMicrotask(() =>
        output.current?.enqueue(new TextEncoder().encode('{"id":1,"result":{"product":"Chrome"}}\0')),
      )
      return client
    },
  })
  launcher = currentLauncher

  expect(await currentLauncher.start()).not.toBeNull()
  expect(timeouts).toEqual([undefined])
})
