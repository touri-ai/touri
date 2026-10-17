import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect as browserExpect, chromium, type Page } from "@playwright/test"
import type { Bot, VmRuntime } from "@touri/contracts"
import { createServer } from "vite"
import { connectCdpWebSocket } from "../../src/browser/cdp"
import { init as initComputer } from "../../src/computer"
import { allowedOrigins, createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import { createAppleContainerProvider } from "../../src/vm"
import { createDesktopGateway } from "../../src/vm/desktop"
import { machineActionRoutes } from "../../src/vm/machine-actions"
import { createVmRuntime } from "../../src/vm/runtime"
import { appleContainerAvailable } from "./integration-available"
import { attemptVnc } from "./vnc-client"

// The pulse alone can pass on an otherwise black display; require actual guest window pixels too.
const guestVisible = (page: Page) =>
  page.waitForFunction(() => {
    const canvas = document.querySelector("canvas")
    if (!canvas) return false
    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data
    if (!pixels) return false
    let visible = 0
    for (let offset = 0; offset < pixels.length; offset += 4)
      if ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 64) visible += 1
    return visible > 10_000
  })

test.skipIf(!appleContainerAvailable)(
  "real noVNC: static desktop for 30 s, guest pulse, view-only, Unicode input, kill switch and frozen frames",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-vnc-integration-"))
    const runtime = createKernel({ appData: root })
    const originalLog = runtime.kernel.log
    let claimed = 0
    let closed = 0
    runtime.kernel.log = (entry) => {
      originalLog(entry)
      if (entry.msg === "Desktop session claimed") claimed += 1
      if (entry.msg === "Desktop session closed") closed += 1
      if (process.env.TOURI_DESKTOP_TRACE === "1" && entry.module === "vm.desktop") console.info(entry.msg, entry.data)
    }
    let clock = Date.now()
    const provider = createAppleContainerProvider({ dataDir: root })
    const vm = createVmRuntime({
      kernel: runtime.kernel,
      provider,
      now: () => clock,
    })
    await initStore(runtime.kernel)
    await initComputer(runtime.kernel)
    runtime.kernel.services.provide("vm.runtime", vm.service)
    const desktop = createDesktopGateway(runtime.kernel, vm.service, vm.paste)
    runtime.kernel.services.provide("vm.desktop", desktop.service)
    runtime.kernel.registerRoutes(desktop.routes)
    runtime.kernel.registerRoutes({ name: "vm-actions", routes: machineActionRoutes(runtime.kernel, vm.service) })
    const vite = await createServer({
      root: join(import.meta.dir, "../../../ui"),
      configFile: join(import.meta.dir, "../../../ui/vite.config.ts"),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    })
    const endpoint = `http://127.0.0.1:${runtime.handshake.port}`
    const request = (path: string, body: unknown = {}) =>
      fetch(`${endpoint}/api/v1${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-ui-token", "X-Touri-Client": "vnc-integration" },
        body: JSON.stringify(body),
      })
    const trustedExec: VmRuntime["exec"] = async ({ botId, ...input }) => {
      const id = vm.service.states().find((state) => state.botId === botId)?.connection?.machineId
      if (!id) throw new Error("Missing test VM")
      return provider.exec({
        id,
        user: "0",
        env: { DISPLAY: ":99", XAUTHORITY: "/var/lib/touri-browser/.Xauthority" },
        ...input,
      })
    }
    let botId: string | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let cdp: Awaited<ReturnType<typeof connectCdpWebSocket>> | undefined
    let origin: string | undefined
    let release: (() => Promise<void>) | undefined
    try {
      const bot = (
        (await (
          await request("/bots", {
            name: "Disposable display",
            provider: "codex",
            machine: "vm",
            computerUse: true,
            machineIdleMinutes: 1,
          })
        ).json()) as { bot: Bot }
      ).bot
      botId = bot.id
      await vite.listen()
      const address = vite.httpServer?.address()
      if (!address || typeof address === "string") throw new Error("Vite port missing")
      origin = `http://127.0.0.1:${address.port}`
      allowedOrigins.add(origin)
      browser = await chromium.launch({ channel: "chrome", headless: true })
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
      const errors: Array<string> = []
      page.on("pageerror", (error) => errors.push(error.message))
      // Hide the marker before connecting: a healthy Xvfb can be entirely static/black.
      // Keep its process alive, then restore the marker to verify real heartbeat stalls too.
      release = await vm.service.acquire({ botId })
      const pulseWindow = await trustedExec({
        botId,
        command: "xdotool",
        args: ["search", "--sync", "--name", "^touri display pulse$"],
      })
      expect(pulseWindow.success).toBe(true)
      if (!pulseWindow.success) throw new Error(pulseWindow.error)
      const windowId = pulseWindow.stdout.trim()
      expect((await trustedExec({ botId, command: "xdotool", args: ["windowunmap", windowId] })).success).toBe(true)
      await page.goto(
        `${origin}/test/e2e/fixtures/desktop.html?computer&endpoint=${encodeURIComponent(endpoint)}&bot=${bot.id}`,
      )
      await page.getByRole("button", { name: "Assumir controle", exact: true }).waitFor({ timeout: 600_000 })
      await browserExpect.poll(() => claimed, { timeout: 600_000 }).toBe(1)
      await release()
      release = undefined
      if (process.env.TOURI_DESKTOP_TRACE === "1") {
        await page.waitForTimeout(3_000)
        console.info(
          "Initial guest canvas",
          await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => ({
            width: canvas.width,
            height: canvas.height,
            pulse: [...(canvas.getContext("2d")?.getImageData(canvas.width - 4, canvas.height - 4, 1, 1).data ?? [])],
          })),
        )
      }
      // The tab must be leased while the viewer is still connecting.
      clock += 60_000
      await vm.service.intent({ botId, intent: "idle" })
      await vm.service.intent({ botId, intent: "background" })
      await vm.sweep()
      expect(vm.service.states().find((machine) => machine.botId === botId)?.status).toBe("running")
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
        null,
        { timeout: 30_000 },
      )
      const image = async () =>
        page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas.getContext("2d")?.getImageData(canvas.width - 4, canvas.height - 4, 1, 1).data
          return data ? [...data] : []
        })
      const first = await image()
      expect(first).toEqual([0, 0, 0, 255])
      // No guest applications, input or visible pulse: the entire framebuffer stays black.
      // Check throughout 30 seconds, so a close/reconnect cannot pass by recovering at the end.
      const initialSessions = { claimed, closed }
      for (let second = 0; second < 30; second += 1) {
        await page.waitForTimeout(1_000)
        expect(await page.locator(".desktop-display").getAttribute("data-phase")).toBe("ready")
        expect({ claimed, closed }).toEqual(initialSessions)
        expect(
          await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
            const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data
            if (!data || canvas.width !== 1440 || canvas.height !== 900) return false
            for (let y = 0; y < canvas.height; y += 1)
              for (let x = 0; x < canvas.width; x += 1) {
                const offset = (y * canvas.width + x) * 4
                if (data[offset] || data[offset + 1] || data[offset + 2]) return false
              }
            return true
          }),
        ).toBe(true)
      }
      expect(initialSessions).toEqual({ claimed: 1, closed: 0 })
      expect((await trustedExec({ botId, command: "xdotool", args: ["windowmap", windowId] })).success).toBe(true)
      await browserExpect.poll(async () => (await image()).slice(1, 3)).toEqual([0x30, 0x40])
      const restoredPulse = await image()
      await page.waitForTimeout(1500)
      expect((await image())[0]).not.toBe(restoredPulse[0])
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)

      // App blur must not park a viewer in a separate window, including while RFB connects.
      await vm.service.intent({ botId, intent: "background" })
      await vm.sweep()
      expect(vm.service.states().find((machine) => machine.botId === botId)?.status).toBe("running")
      expect((await image()).slice(1, 3)).toEqual([0x30, 0x40])

      // An open terminal keeps a presence lease after its viewer socket is gone.
      await page.getByRole("button", { name: "Terminal", exact: true }).click()
      await browserExpect(page.getByLabel("Comando na VM")).toBeVisible()
      await vm.service.intent({ botId, intent: "background" })
      await vm.sweep()
      expect(vm.service.states().find((machine) => machine.botId === botId)?.status).toBe("running")
      await page.getByRole("button", { name: "Área de trabalho", exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
      )

      // The real viewer authenticates through the sidecar; direct unauthenticated clients cannot attach.
      const connection = await vm.service.desktopConnection({ botId })
      expect(connection.password).toHaveLength(8)
      const passwordMode = await trustedExec({
        botId,
        command: "stat",
        args: ["-c", "%a", "/tmp/touri-vnc/passwd"],
      })
      expect(passwordMode.success && passwordMode.stdout.trim()).toBe("600")
      expect(await attemptVnc(connection.url.startsWith("unix:") ? connection.url : connection.hostPort)).toBe(false)
      expect(
        await attemptVnc(connection.url.startsWith("unix:") ? connection.url : connection.hostPort, "wrong123"),
      ).toBe(false)
      expect(
        await attemptVnc(
          connection.url.startsWith("unix:") ? connection.url : connection.hostPort,
          connection.password,
        ),
      ).toBe(true)

      // A guest page records actual X11 key delivery. It uses the runtime's existing headed Chromium.
      const browserWs = await vm.service.browserEndpoint({ botId })
      if (!browserWs) throw new Error("Guest browser did not start")
      const host = new URL(browserWs)
      const capabilityPath = host.pathname.slice(0, host.pathname.indexOf("/devtools/"))
      const tabs = (await (await fetch(`http://${host.host}${capabilityPath}/json/list`)).json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
      }>
      const tab = tabs.find((entry) => entry.type === "page")
      if (!tab) throw new Error("Guest browser tab missing")
      const target = new URL(tab.webSocketDebuggerUrl)
      target.host = host.host
      target.pathname = `${capabilityPath}${target.pathname}`
      cdp = await connectCdpWebSocket({ url: target.toString() })
      await cdp.call("Page.navigate", {
        url: `data:text/html,${encodeURIComponent('<textarea id="text" autofocus></textarea>')}`,
      })
      // Page.navigate completes before the new document/focus is ready. Empty input
      // otherwise looks like a Unicode mapping failure even for the ASCII prefix.
      await browserExpect
        .poll(async () => {
          const value = await cdp?.call("Runtime.evaluate", {
            expression: "document.readyState === 'complete' && !!document.querySelector('textarea')",
            returnByValue: true,
          })
          return (value as { result?: { value?: boolean } }).result?.value
        })
        .toBe(true)
      // Navigation/autofocus alone does not focus the native Chromium page in Xvfb.
      await cdp.call("Page.bringToFront", {})
      await cdp.call("Runtime.evaluate", { expression: "document.querySelector('textarea').focus()" })
      await browserExpect
        .poll(async () => {
          const value = await cdp?.call("Runtime.evaluate", {
            expression: "document.activeElement === document.querySelector('textarea') && document.hasFocus()",
            returnByValue: true,
          })
          return (value as { result?: { value?: boolean } }).result?.value
        })
        .toBe(true)
      await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
      await page.getByRole("button", { name: "Devolver ao bot" }).waitFor({ timeout: 30_000 })
      await guestVisible(page)
      await page.getByLabel("Digitar na VM").fill("Olá 日本")
      let typed = ""
      for (let i = 0; i < 50; i += 1) {
        const value = await cdp.call("Runtime.evaluate", {
          expression: "document.querySelector('textarea')?.value",
          returnByValue: true,
        })
        typed = (value as { result?: { value?: string } }).result?.value ?? ""
        if (typed === "Olá 日本") break
        await page.waitForTimeout(100)
      }
      if (process.env.TOURI_DESKTOP_TRACE === "1") {
        console.info(
          "Guest focus",
          await cdp.call("Runtime.evaluate", {
            expression:
              "JSON.stringify({ready:document.readyState, focus:document.hasFocus(), active:document.activeElement?.outerHTML})",
            returnByValue: true,
          }),
        )
        console.info(
          "Guest X focus",
          await trustedExec({ botId, command: "xdotool", args: ["getwindowfocus", "getwindowname"] }),
        )
        console.info(
          "Guest VNC log",
          await trustedExec({ botId, command: "tail", args: ["-30", "/run/touri-vnc.log"] }),
        )
      }
      expect(typed).toBe("Olá 日本")
      const killed = page.waitForResponse(
        (response) => response.url().endsWith("/computer/kill") && response.status() === 200,
      )
      await page.getByLabel("Digitar na VM").press("Control+Alt+Meta+Period")
      await killed
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
      )
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      await guestVisible(page)
      expect(
        await page.getByRole("button", { name: "Assumir controle", exact: true }).getAttribute("aria-pressed"),
      ).toBe("false")
      expect(
        (
          (await cdp.call("Runtime.evaluate", {
            expression: "document.querySelector('textarea')?.value",
            returnByValue: true,
          })) as { result?: { value?: string } }
        ).result?.value,
      ).toBe("Olá 日本")

      // A host notification must also stop a controlling viewer in a separate window.
      const popout = await browser.newPage({ viewport: { width: 1100, height: 780 } })
      popout.on("pageerror", (error) => errors.push(error.message))
      await popout.goto(
        `${origin}/test/e2e/fixtures/desktop.html?computer&endpoint=${encodeURIComponent(endpoint)}&bot=${bot.id}`,
      )
      await popout.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
      )
      await popout.getByRole("button", { name: "Assumir controle", exact: true }).click()
      await popout.getByRole("button", { name: "Devolver ao bot" }).waitFor()
      await guestVisible(popout)
      runtime.emitHostNotification({ method: "computer.killSwitch", params: { at: Date.now() } })
      await popout.getByRole("button", { name: "Reconectar tela" }).last().waitFor()
      expect(await popout.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      await popout.close()

      // Once observed, the heartbeat remains mandatory even with an otherwise live socket.
      const heartbeatProcess = "/usr/local/lib/touri/display-heartbeat.py"
      expect(
        (
          await trustedExec({
            botId,
            command: "python3",
            args: [
              "-c",
              "import os,pathlib,signal,sys; pids=[int(p.parent.name) for p in pathlib.Path('/proc').glob('[0-9]*/cmdline') if p.read_bytes().split(bytes([0]))[1:2]==[sys.argv[1].encode()]]; assert len(pids)==1; os.kill(pids[0],signal.SIGSTOP)",
              heartbeatProcess,
            ],
          })
        ).success,
      ).toBe(true)
      await page.getByRole("button", { name: "Reconectar tela" }).last().waitFor({ timeout: 20_000 })
      expect(
        (
          await trustedExec({
            botId,
            command: "python3",
            args: [
              "-c",
              "import os,pathlib,signal,sys; pids=[int(p.parent.name) for p in pathlib.Path('/proc').glob('[0-9]*/cmdline') if p.read_bytes().split(bytes([0]))[1:2]==[sys.argv[1].encode()]]; assert len(pids)==1; os.kill(pids[0],signal.SIGCONT)",
              heartbeatProcess,
            ],
          })
        ).success,
      ).toBe(true)
      await page.getByRole("button", { name: "Reconectar tela" }).last().click()
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
      )
      await browserExpect.poll(async () => (await image()).slice(1, 3)).toEqual([0x30, 0x40])

      // Pause only the VNC process inside this test's disposable guest. The X11 heartbeat still runs.
      expect((await trustedExec({ botId, command: "pkill", args: ["-STOP", "-x", "x11vnc"] })).success).toBe(true)
      await page.getByRole("button", { name: "Reconectar tela" }).last().waitFor({ timeout: 20_000 })
      expect((await trustedExec({ botId, command: "pkill", args: ["-CONT", "-x", "x11vnc"] })).success).toBe(true)
      await page.getByRole("button", { name: "Reconectar tela" }).last().click()
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>(".desktop-panel button[aria-pressed]")?.disabled === false,
      )
      await guestVisible(page)
      expect(errors).toEqual([])
    } finally {
      await cdp?.close()
      await browser?.close()
      desktop.service.dispose()
      await release?.()
      if (botId) await vm.service.destroy({ botId })
      await vm.dispose()
      runtime.emitHostNotification({ method: "app.willQuit", params: {} })
      runtime.stop()
      await vite.close()
      if (origin) allowedOrigins.delete(origin)
      rmSync(root, { recursive: true, force: true })
    }
  },
  900_000,
)
