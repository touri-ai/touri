import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { createCdpClient } from "../../src/browser/cdp"
import { createChromeLauncher } from "../../src/browser/launcher"
import { BrowserSandboxUnavailableError } from "../../src/browser/sandbox"
import { createKernel } from "../../src/kernel"

let root: string | null = null
let runtime: ReturnType<typeof createKernel> | null = null
let launcher: ReturnType<typeof createChromeLauncher> | null = null

afterEach(async () => {
  await launcher?.stop()
  runtime?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

test("Chrome launcher preserves the CDP client's default timeout for startup calls", async () => {
  root = mkdtempSync(join(tmpdir(), "touri-chrome-launcher-timeout-"))
  runtime = createKernel({ appData: root })
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
    env: { TOURI_CHROME_BIN: "chrome-test-binary", TOURI_BROWSER_HEADLESS: "1" },
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

test("a denied namespace produces a safe diagnosis without an automatic unsandboxed retry", async () => {
  root = mkdtempSync(join(tmpdir(), "touri-chrome-sandbox-"))
  runtime = createKernel({ appData: root })
  const calls: Array<Array<string>> = []
  const kernel = {
    ...runtime.kernel,
    spawnTree: (input: Parameters<Kernel["spawnTree"]>[0]) => {
      calls.push(input.args ?? [])
      return {
        success: true as const,
        target: "local" as const,
        pid: 1,
        pgid: 1,
        stdout: new Blob([]).stream(),
        stderr: new Blob(["private prefix: Failed to move to new namespace: Operation not permitted"]).stream(),
        stdin: new WritableStream<Uint8Array>(),
        extra: [
          { write: new WritableStream<Uint8Array>(), read: null },
          { read: new Blob([]).stream(), write: null },
        ],
        exited: Promise.resolve({ code: 1, signal: null }),
        kill: () => {},
      }
    },
  }
  launcher = createChromeLauncher({
    kernel,
    env: { TOURI_CHROME_BIN: "chrome-fixture", TOURI_BROWSER_HEADLESS: "1" },
    createClient: () => {
      throw new Error("Debugging pipe closed")
    },
  })

  await expect(launcher.start()).rejects.toBeInstanceOf(BrowserSandboxUnavailableError)

  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toContain("--no-sandbox")
})
