import { type Browser, chromium } from "@playwright/test"
import { connectCdpWebSocket } from "../../../sidecar/src/browser/cdp"
import type { ChromeLauncher } from "../../../sidecar/src/browser/launcher"
import type { CdpClient } from "../../../sidecar/src/browser/types"

/** The test runner owns this disposable browser and its loopback CDP transport. */
export const createFixtureBrowserLauncher = (): ChromeLauncher & {
  connectInspection: () => Promise<CdpClient | null>
} => {
  let active: { browser: Browser; client: CdpClient; url: string } | null = null
  const stop = async (): Promise<void> => {
    const current = active
    active = null
    if (!current) return
    await current.client.close()
    await current.browser.close()
  }
  const start: ChromeLauncher["start"] = async (input) => {
    if (active && !active.client.isClosed()) return { client: active.client }
    await stop()
    if (input?.runningOnly) return null
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
    const port = reservation.port
    await reservation.stop(true)
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    })
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error("Test browser transport did not start")
      const version = (await response.json()) as { webSocketDebuggerUrl: string }
      const client = await connectCdpWebSocket({ url: version.webSocketDebuggerUrl, timeoutMs: 5_000 })
      active = { browser, client, url: version.webSocketDebuggerUrl }
      return { client }
    } catch (error) {
      await browser.close()
      throw error
    }
  }

  const connectInspection = async (): Promise<CdpClient | null> =>
    active ? connectCdpWebSocket({ url: active.url, timeoutMs: 5_000 }) : null

  return { start, stop, connectInspection }
}
