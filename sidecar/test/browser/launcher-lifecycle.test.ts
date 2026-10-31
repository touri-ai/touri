import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { createChromeLauncher } from "../../src/browser/launcher"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("a restart waits for an in-flight browser shutdown before reading its launch environment", async () => {
  const fixture = await getLauncherFixture()
  await fixture.launcher.start()

  const stopped = fixture.launcher.stop()
  await fixture.closing.promise
  const restarted = fixture.launcher.start()
  const readsDuringShutdown = fixture.environmentReads.size
  fixture.exited.resolve({ code: 0, signal: null })
  await stopped
  await restarted

  expect(readsDuringShutdown).toBe(1)
  expect(fixture.environmentReads.size).toBe(2)
})

test("stop waits for a canceled startup to release its browser process", async () => {
  const environment = Promise.withResolvers<Record<string, string>>()
  const fixture = await getLauncherFixture(environment.promise)
  const started = fixture.launcher.start()
  await fixture.environmentEntered.promise

  const stopped = fixture.launcher.stop().then(() => fixture.events.add("stopped"))
  environment.resolve({})
  await Promise.all([started, stopped])

  expect(await started).toBeNull()
  expect(Array.from(fixture.events)).toEqual(["spawned", "exited", "stopped"])
})

const getLauncherFixture = async (environment?: Promise<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), "touri-launcher-lifecycle-"))
  const runtime = createKernel({ appData: root })
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  const closing = Promise.withResolvers<void>()
  const environmentEntered = Promise.withResolvers<void>()
  const environmentReads = new Set<number>()
  const events = new Set<string>()
  const kernel: Kernel = Object.assign({}, runtime.kernel, {
    shellEnv: () => {
      environmentReads.add(environmentReads.size)
      environmentEntered.resolve()
      return environment ?? Promise.resolve({})
    },
    spawnTree: () => {
      const first = !events.has("spawned")
      const currentExit = first ? exited : Promise.withResolvers<{ code: number | null; signal: string | null }>()
      const output = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
      events.add("spawned")
      return {
        success: true as const,
        pid: 1,
        pgid: 1,
        stdout: new Blob([]).stream(),
        stderr: new Blob([]).stream(),
        stdin: new WritableStream<Uint8Array>(),
        extra: [
          {
            read: null,
            write: new WritableStream<Uint8Array>({
              write: async (bytes) => {
                const command = JSON.parse(new TextDecoder().decode(bytes).replace(/\0$/u, "")) as {
                  id: number
                  method: string
                }
                if (command.method === "Browser.close") {
                  closing.resolve()
                  if (!first) currentExit.resolve({ code: 0, signal: null })
                }
                const controller = await output.promise
                controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: command.id, result: {} })}\0`))
              },
            }),
          },
          {
            read: new ReadableStream<Uint8Array>({ start: (controller) => output.resolve(controller) }),
            write: null,
          },
        ],
        exited: currentExit.promise.then((exit) => {
          events.add("exited")
          return exit
        }),
        kill: () => currentExit.resolve({ code: 0, signal: null }),
      }
    },
  })
  const launcher = createChromeLauncher({
    kernel,
    env: { TOURI_CHROME_BIN: "browser-fixture", TOURI_BROWSER_HEADLESS: "1" },
  })
  cleanups.add(async () => {
    exited.resolve({ code: 0, signal: null })
    await launcher.stop()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })

  return { launcher, exited, closing, environmentEntered, environmentReads, events }
}
