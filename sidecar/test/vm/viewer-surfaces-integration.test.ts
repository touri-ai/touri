import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join, normalize } from "node:path"
import { expect as browserExpect, type Page, webkit } from "@playwright/test"
import type { Bot, ToolContext } from "@touri/contracts"
import { build } from "vite"
import { connectCdpWebSocket } from "../../src/browser/cdp"
import { createRoutedBrowserEngine } from "../../src/browser/vm-router"
import { init as initComputer } from "../../src/computer"
import { allowedOrigins, createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import { createAppleContainerProvider } from "../../src/vm"
import { createDesktopGateway } from "../../src/vm/desktop"
import { machineActionRoutes } from "../../src/vm/machine-actions"
import { createVmRuntime } from "../../src/vm/runtime"
import { appleContainerAvailable } from "./integration-available"

const UI_ROOT = join(import.meta.dir, "../../../ui")
const TAURI_CONFIG = join(import.meta.dir, "../../../src-tauri/tauri.conf.json")
const PROOF_DIR = process.env.TOURI_PREVIEW_PROOF_DIR
const GUEST_PAGE = `<!doctype html><title>touri proof</title>
<style>html,body{margin:0;height:100%}body{background:linear-gradient(90deg,#c0392b,#2980b9 50%,#27ae60)}
#field{position:fixed;left:5vw;top:30vh;width:90vw;height:40vh;font:64px sans-serif}</style>
<input id="field" placeholder="digite aqui">
<script>window.clicks=0;addEventListener("mousedown",()=>{window.clicks++})</script>`
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

/** Serves the production UI bundle with the exact desktop CSP, so blocked image/fetch schemes fail like the app. */
const serveUi = (dist: string, csp: string) =>
  Bun.serve({
    hostname: "localhost",
    port: 0,
    fetch: (request) => {
      const path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^(\.\.[/\\])+/, "")
      const file = join(dist, path === "/" ? "index.html" : path)
      try {
        return new Response(readFileSync(file), {
          headers: {
            "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
            "Content-Security-Policy": csp,
          },
        })
      } catch {
        return new Response("not found", { status: 404 })
      }
    },
  })

/** Mean per-channel variance of a page-side image, sampled through a canvas. */
const imageVariance = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element: HTMLImageElement) => {
    if (!element.complete || !element.naturalWidth) return -1
    const canvas = document.createElement("canvas")
    canvas.width = element.naturalWidth
    canvas.height = element.naturalHeight
    const context = canvas.getContext("2d")
    if (!context) return -1
    context.drawImage(element, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let sum = 0
    let squares = 0
    let count = 0
    for (let offset = 0; offset < data.length; offset += 4)
      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[offset + channel] ?? 0
        sum += value
        squares += value * value
        count += 1
      }
    const mean = sum / count
    return squares / count - mean * mean
  })

const canvasVariance = (page: Page) =>
  page.locator(".desktop-canvas canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data
    if (!data?.length) return -1
    let sum = 0
    let squares = 0
    let count = 0
    for (let offset = 0; offset < data.length; offset += 16)
      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[offset + channel] ?? 0
        sum += value
        squares += value * value
        count += 1
      }
    const mean = sum / count
    return squares / count - mean * mean
  })

test.skipIf(!appleContainerAvailable)(
  "real VM under the desktop CSP: inline chat preview, popout window and takeover input all reach the guest",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-viewer-surfaces-"))
    const dist = join(root, "dist")
    await build({
      root: UI_ROOT,
      configFile: join(UI_ROOT, "vite.config.ts"),
      logLevel: "warn",
      build: {
        outDir: dist,
        emptyOutDir: true,
        rollupOptions: {
          input: {
            main: join(UI_ROOT, "index.html"),
            inline: join(UI_ROOT, "test/e2e/fixtures/inline-preview.html"),
          },
        },
      },
    })
    const csp = (JSON.parse(readFileSync(TAURI_CONFIG, "utf8")) as { app: { security: { csp: string } } }).app.security
      .csp
    const ui = serveUi(dist, csp)
    const origin = `http://localhost:${ui.port}`
    allowedOrigins.add(origin)
    const runtime = createKernel({ appData: root })
    const provider = createAppleContainerProvider({ dataDir: root })
    const vm = createVmRuntime({ kernel: runtime.kernel, provider })
    await initStore(runtime.kernel)
    await initComputer(runtime.kernel)
    runtime.kernel.services.provide("vm.runtime", vm.service)
    const desktop = createDesktopGateway(runtime.kernel, vm.service, vm.paste)
    runtime.kernel.services.provide("vm.desktop", desktop.service)
    runtime.kernel.registerRoutes(desktop.routes)
    runtime.kernel.registerRoutes({ name: "vm-actions", routes: machineActionRoutes(runtime.kernel, vm.service) })
    runtime.kernel.registerRoutes({
      name: "vm-machines",
      routes: [
        {
          method: "GET",
          path: "/machines",
          handler: async () => ({
            status: 200,
            json: { capability: vm.service.capability, machines: vm.service.states() },
          }),
        },
      ],
    })
    const engine = createRoutedBrowserEngine(runtime.kernel, "system-chrome")
    const endpoint = `http://127.0.0.1:${runtime.handshake.port}`
    const errors: Array<string> = []
    const consoleLines: Array<string> = []
    let botId: string | undefined
    let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined
    let cdp: Awaited<ReturnType<typeof connectCdpWebSocket>> | undefined
    try {
      const bot = (
        (await (
          await fetch(`${endpoint}/api/v1/bots`, {
            method: "POST",
            headers: { Authorization: "Bearer dev-ui-token", "X-Touri-Client": "viewer-surfaces" },
            body: JSON.stringify({ name: "Viewer surfaces", provider: "codex", machine: "vm", computerUse: true }),
          })
        ).json()) as { bot: Bot }
      ).bot
      botId = bot.id
      const ctx: ToolContext = {
        botId,
        threadId: bot.mainThreadId ?? "",
        runId: null,
        projectId: null,
        cwd: root,
        signal: new AbortController().signal,
      }
      const opened = await engine.open({ url: "http://example.com", ctx, timeoutMs: 120_000 })
      if (!opened.success) console.info("[viewer surfaces] open failed", opened)
      expect(opened.success).toBe(true)

      const browserWs = await vm.service.browserEndpoint({ botId })
      if (!browserWs) throw new Error("Guest browser did not start")
      const host = new URL(browserWs)
      const capabilityPath = host.pathname.slice(0, host.pathname.indexOf("/devtools/"))
      const tabs = (await (await fetch(`http://${host.host}${capabilityPath}/json/list`)).json()) as Array<{
        type: string
        url: string
        webSocketDebuggerUrl: string
      }>
      const tab = tabs.find((entry) => entry.type === "page" && entry.url.includes("example.com"))
      if (!tab) throw new Error("Guest proof tab missing")
      const target = new URL(tab.webSocketDebuggerUrl)
      target.host = host.host
      target.pathname = `${capabilityPath}${target.pathname}`
      cdp = await connectCdpWebSocket({ url: target.toString() })
      const guest = async <T>(expression: string): Promise<T | undefined> => {
        try {
          const evaluated = (await cdp?.call("Runtime.evaluate", { expression, returnByValue: true })) as {
            result?: { value?: T }
          }
          return evaluated.result?.value
        } catch {
          return undefined
        }
      }
      await cdp.call("Runtime.evaluate", {
        expression: `document.open();document.write(${JSON.stringify(GUEST_PAGE)});document.close()`,
      })
      await browserExpect.poll(() => guest<string>("document.title"), { timeout: 20_000 }).toBe("touri proof")
      await cdp.call("Page.bringToFront", {})
      browser = await webkit.launch()
      const watch = (page: Page, name: string) => {
        page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`))
        page.on("console", (message) => consoleLines.push(`${name}: ${message.text()}`))
      }

      // R13-01: the inline chat preview, built and served exactly like the app (CSP included).
      const inline = await browser.newPage({ viewport: { width: 900, height: 700 } })
      watch(inline, "inline")
      await inline.goto(
        `${origin}/test/e2e/fixtures/inline-preview.html?endpoint=${encodeURIComponent(endpoint)}&bot=${botId}`,
      )
      const preview = 'img[alt="Última imagem do computador"]'
      await inline.locator(preview).waitFor({ timeout: 60_000 })
      await browserExpect.poll(() => imageVariance(inline, preview), { timeout: 30_000 }).toBeGreaterThan(200)
      if (PROOF_DIR) {
        mkdirSync(PROOF_DIR, { recursive: true })
        await inline.getByRole("button", { name: "Ampliar prévia do computador" }).click()
        await inline.screenshot({ path: join(PROOF_DIR, "inline.png") })
      }
      // computer_screenshot runs as the browser uid with its private X authority: it must see the page too.
      const shot = await vm.service.computer({ ctx, name: "computer_screenshot", args: {} })
      if (!shot.success) throw new Error(shot.error)
      const shotData = shot.content?.find((part) => part.type === "image")
      if (shotData?.type !== "image") throw new Error("computer_screenshot returned no image")
      await inline.evaluate((src) => {
        const image = document.createElement("img")
        image.id = "computer-shot"
        image.src = src
        document.body.append(image)
      }, `data:image/png;base64,${shotData.data}`)
      await browserExpect.poll(() => imageVariance(inline, "#computer-shot"), { timeout: 10_000 }).toBeGreaterThan(200)
      if (PROOF_DIR) writeFileSync(join(PROOF_DIR, "computer-screenshot.png"), Buffer.from(shotData.data, "base64"))
      await inline.close()

      // R13-03: the popout loads the real app entry with ?computer=<bot>, bootstrapped like a Tauri window.
      const popout = await browser.newPage({ viewport: { width: 1100, height: 780 } })
      watch(popout, "popout")
      await popout.addInitScript(
        ({ endpoint, label }) => {
          const callbacks = new Map<number, unknown>()
          // A Tauri popout that opens behind the main window is occluded: WebKit reports it hidden.
          const visibility = { hidden: true }
          Object.defineProperty(Document.prototype, "hidden", { get: () => visibility.hidden })
          Object.defineProperty(Document.prototype, "visibilityState", {
            get: () => (visibility.hidden ? "hidden" : "visible"),
          })
          Object.assign(window, {
            __touriReveal: () => {
              visibility.hidden = false
              document.dispatchEvent(new Event("visibilitychange"))
            },
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
            __TAURI_INTERNALS__: {
              metadata: {
                currentWindow: { label },
                currentWebview: { label, windowLabel: label },
              },
              transformCallback: (callback: unknown) => {
                const id = callbacks.size + 1
                callbacks.set(id, callback)
                return id
              },
              convertFileSrc: (path: string) => path,
              invoke: async (command: string) => {
                if (command === "sidecar_endpoint")
                  return {
                    baseUrl: endpoint,
                    wsUrl: `${endpoint.replace("http:", "ws:")}/api/v1/events`,
                    token: "dev-ui-token",
                  }
                if (command.startsWith("plugin:event|")) return 1
                return null
              },
            },
          })
        },
        { endpoint, label: `computer-${botId}` },
      )
      await popout.goto(`${origin}/index.html?computer=${botId}`)
      await popout.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
        null,
        { timeout: 120_000 },
      )
      await browserExpect.poll(() => canvasVariance(popout), { timeout: 30_000 }).toBeGreaterThan(200)
      expect(await popout.evaluate(() => document.hidden)).toBe(true)
      expect(await popout.locator(".desktop-display").getAttribute("data-phase")).toBe("ready")
      await popout.evaluate(() => (window as unknown as { __touriReveal: () => void }).__touriReveal())
      if (PROOF_DIR) await popout.screenshot({ path: join(PROOF_DIR, "popout.png") })

      // R13-02: Take over, then a real pointer click and typed keys through the viewer's RFB path.
      await popout.getByRole("button", { name: "Assumir controle", exact: true }).click()
      await popout.getByRole("button", { name: "Devolver ao bot" }).waitFor({ timeout: 30_000 })
      await browserExpect(popout.getByLabel("Digitar na VM")).toBeEnabled()
      if (PROOF_DIR) await popout.screenshot({ path: join(PROOF_DIR, "takeover-before.png") })
      const clicksBefore = (await guest<number>("window.clicks")) ?? 0
      const canvas = popout.locator(".desktop-canvas canvas")
      const box = await canvas.boundingBox()
      if (!box) throw new Error("Viewer canvas missing")
      await popout.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await browserExpect
        .poll(async () => (await guest<number>("window.clicks")) ?? 0, { timeout: 10_000 })
        .toBeGreaterThan(clicksBefore)
      await browserExpect
        .poll(() => guest<boolean>("document.activeElement?.id === 'field'"), { timeout: 10_000 })
        .toBe(true)
      await browserExpect.poll(() => popout.evaluate(() => document.activeElement?.id)).toBe(`desktop-input-${botId}`)
      await popout.keyboard.type("touri ok 42", { delay: 30 })
      await browserExpect
        .poll(() => guest<string>("document.querySelector('#field').value"), { timeout: 10_000 })
        .toBe("touri ok 42")
      await popout.waitForTimeout(1_500)
      if (PROOF_DIR) {
        await popout.screenshot({ path: join(PROOF_DIR, "takeover-after.png") })
        writeFileSync(join(PROOF_DIR, "console.log"), consoleLines.join("\n"))
      }
      expect(consoleLines.filter((line) => /Content Security Policy/.test(line))).toEqual([])
      expect(errors).toEqual([])
    } catch (error) {
      console.info("[viewer surfaces] console", consoleLines.slice(-40))
      console.info("[viewer surfaces] errors", errors)
      throw error
    } finally {
      await cdp?.close()
      await browser?.close()
      desktop.service.dispose()
      await engine.shutdown()
      if (botId) await vm.service.destroy({ botId, deleteVolumes: true })
      await vm.dispose()
      runtime.emitHostNotification({ method: "app.willQuit", params: {} })
      runtime.stop()
      ui.stop(true)
      allowedOrigins.delete(origin)
      rmSync(root, { recursive: true, force: true })
    }
  },
  900_000,
)
