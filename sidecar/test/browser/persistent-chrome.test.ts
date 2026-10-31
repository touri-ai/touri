import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChromeLauncher, getChromeProfilePath } from "../../src/browser/launcher"
import type { CdpClient } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"
import { getSystemBrowserCapability } from "./system-browser-capability"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const capability = await getSystemBrowserCapability()
if (!capability.available) console.info(`System browser persistence: skipped — ${capability.reason}`)

test.skipIf(!capability.available).each(Array.from({ length: 30 }, (_, index) => index + 1))(
  "headful stable Chrome preserves a bot profile across real process restarts (%i)",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "touri-persistent-chrome-"))
    const runtime = createKernel({ appData: root })
    cleanups.add(async () => {
      await runtime.stop()
      await rm(root, { recursive: true, force: true })
    })
    const server = getFixtureServer()
    cleanups.add(async () => {
      server.stop(true)
    })
    const url = `http://127.0.0.1:${server.port}`
    const env = { TOURI_BROWSER_HEADLESS: "0", DISPLAY: "", WAYLAND_DISPLAY: "", TOURI_HEADLESS: "1" }
    const launcher = createChromeLauncher({ kernel: runtime.kernel, botId: "lia", env })
    cleanups.add(() => launcher.stop())
    const first = await launcher.start()
    expect(first).not.toBeNull()
    if (!first?.process) throw new Error("Stable Chrome did not start its own process")
    const sessionId = await openPage(first.client, url)
    const identity = await evaluate(
      first.client,
      sessionId,
      `({ userAgent: navigator.userAgent, automated: navigator.webdriver, locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, webgl: Boolean(document.createElement('canvas').getContext('webgl')) })`,
    )
    const firstUserAgent = await evaluate(first.client, sessionId, "navigator.userAgent")
    console.log(JSON.stringify({ identity }))
    expect(JSON.stringify(identity)).not.toContain("HeadlessChrome")
    expect(identity).toMatchObject({ automated: false })
    await evaluate(
      first.client,
      sessionId,
      `localStorage.setItem('synthetic-profile', 'lia'); document.cookie = 'synthetic-session=lia; Max-Age=86400; SameSite=Strict'; true`,
    )

    await launcher.stop()
    expect(await first.process.exited).toEqual({ code: 0, signal: null })
    const restarted = await launcher.start()
    if (!restarted?.process) throw new Error("Stable Chrome did not restart its own process")
    expect(restarted.process.pid).not.toBe(first.process.pid)
    const restartedSession = await openPage(restarted.client, url)
    const saved = await evaluate(
      restarted.client,
      restartedSession,
      `({ storage: localStorage.getItem('synthetic-profile'), cookie: document.cookie, userAgent: navigator.userAgent })`,
    )

    expect(saved).toMatchObject({ storage: "lia", cookie: "synthetic-session=lia", userAgent: firstUserAgent })
    const profile = getChromeProfilePath(runtime.kernel.paths, "lia")
    expect((await stat(profile)).mode & 0o777).toBe(0o700)
    await launcher.stop()
    const other = createChromeLauncher({ kernel: runtime.kernel, botId: "leo", env })
    cleanups.add(() => other.stop())
    const isolated = await other.start()
    if (!isolated) throw new Error("Isolated Chrome did not start")
    const isolatedSession = await openPage(isolated.client, url)
    expect(
      await evaluate(
        isolated.client,
        isolatedSession,
        `({ storage: localStorage.getItem('synthetic-profile'), cookie: document.cookie })`,
      ),
    ).toEqual({ storage: null, cookie: "" })
  },
  120_000,
)

const getFixtureServer = () => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () =>
          new Response("<!doctype html><title>Synthetic browser profile</title>", {
            headers: { "content-type": "text/html" },
          }),
      })
    } catch {
      /* Another isolated fixture owns this port. */
    }
  }
  throw new Error("No free fixture port")
}

const openPage = async (client: CdpClient, url: string): Promise<string> => {
  const { targetId } = await client.call<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
  const { sessionId } = await client.call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
  await client.call("Page.navigate", { url }, sessionId)
  const deadline = performance.now() + 10_000
  const wait = async (): Promise<string> => {
    if (
      await evaluate(
        client,
        sessionId,
        `location.origin === ${JSON.stringify(url)} && document.readyState === 'complete'`,
      )
    )
      return sessionId
    if (performance.now() >= deadline) throw new Error("Fixture page did not load")
    await Bun.sleep(25)
    return wait()
  }
  return wait()
}

const evaluate = async (client: CdpClient, sessionId: string, expression: string): Promise<unknown> => {
  const result = await client.call<{ result: { value?: unknown } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    sessionId,
  )
  return result.result.value
}
