import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer as createTcpServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect as browserExpect, chromium } from "@playwright/test"
import type { Bot } from "@touri/contracts"
import { createServer } from "vite"
import { init as initComputer } from "../../src/computer"
import { allowedOrigins, createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import { createDesktopGateway } from "../../src/vm/desktop"
import { createVmRuntime } from "../../src/vm/runtime"
import { vncPasswordFile } from "../../src/vm/vnc-auth"
import { fakeVmProvider } from "./fake-provider"
import { attemptVnc } from "./vnc-client"

const available =
  process.platform === "linux" &&
  ["Xvfb", "x11vnc", "python3"].every((tool) => Bun.which(tool)) &&
  existsSync(chromium.executablePath())

const unusedPort = async () => {
  const reservation = createTcpServer()
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const address = reservation.address()
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("Missing test port")
  return address.port
}

test.skipIf(!available)(
  "real local X11/noVNC: heartbeat, Unicode/IME, mouse, stop and frozen render",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-vnc-local-"))
    const children: Array<ReturnType<typeof Bun.spawn>> = []
    const spawn = (cmd: Array<string>, display?: string) => {
      const child = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "ignore",
        ...(display ? { env: { ...process.env, DISPLAY: display } } : {}),
      })
      children.push(child)
      return child
    }
    const runtime = createKernel({ appData: root })
    const vm = createVmRuntime({
      kernel: runtime.kernel,
      provider: fakeVmProvider().provider,
      capability: { available: true, provider: "fake", reason: null },
    })
    const vite = await createServer({
      root: join(import.meta.dir, "../../../ui"),
      ...(process.env.TOURI_VITE_CACHE_DIR ? { cacheDir: process.env.TOURI_VITE_CACHE_DIR } : {}),
      configFile: join(import.meta.dir, "../../../ui/vite.config.ts"),
      optimizeDeps: { entries: ["test/e2e/fixtures/desktop.html"] },
      server: { host: "127.0.0.1", port: await unusedPort(), strictPort: true },
    })
    let desktop: ReturnType<typeof createDesktopGateway> | undefined
    let viewer: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let guest: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let origin: string | undefined
    try {
      // The X server allocates a free display, never touching the host's existing :99.
      const xvfb = spawn(["Xvfb", "-displayfd", "1", "-screen", "0", "800x600x24", "-nolisten", "tcp"])
      const reader = xvfb.stdout.getReader()
      const line = await reader.read()
      reader.releaseLock()
      const display = `:${new TextDecoder().decode(line.value).trim()}`
      expect(display).toMatch(/^:\d+$/)
      const reservation = createTcpServer()
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
      const address = reservation.address()
      if (!address || typeof address === "string") throw new Error("VNC port missing")
      await new Promise<void>((resolve) => reservation.close(() => resolve()))
      let password = "touri123"
      const passwordPath = join(root, "passwd")
      const logPath = join(root, "vnc.log")
      writeFileSync(passwordPath, vncPasswordFile(password), { mode: 0o600 })
      const vnc = spawn(
        [
          "x11vnc",
          "-display",
          display,
          "-localhost",
          "-rfbport",
          String(address.port),
          "-rfbversion",
          "3.8",
          "-norc",
          "-rfbauth",
          passwordPath,
          "-o",
          logPath,
          "-xkb",
          "-add_keysyms",
          "-forever",
          "-shared",
          "-clear_keys",
          "-noxdamage",
        ],
        display,
      )
      const heartbeat = spawn(["python3", join(import.meta.dir, "../../src/vm/image/display-heartbeat.py")], display)
      await browserExpect.poll(() => attemptVnc(address.port, password), { timeout: 10_000 }).toBe(true)
      await initStore(runtime.kernel)
      await initComputer(runtime.kernel)
      runtime.kernel.services.provide("vm.runtime", vm.service)
      const leases: Array<boolean | undefined> = []
      let pastes = 0
      desktop = createDesktopGateway(runtime.kernel, {
        ...vm.service,
        acquire: async ({ runningOnly }) => {
          leases.push(runningOnly)
          return async () => {}
        },
        forwardPort: async () => ({ hostPort: address.port, url: `http://127.0.0.1:${address.port}` }),
        desktopConnection: async () => ({ hostPort: address.port, url: `http://127.0.0.1:${address.port}`, password }),
        exec: async ({ command, args = [], signal }) => {
          pastes++
          const child = spawn([command, ...args], display)
          const abort = () => child.kill("SIGTERM")
          signal?.addEventListener("abort", abort, { once: true })
          if (signal?.aborted) abort()
          try {
            const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
            return { success: true, stdout, stderr: "", code }
          } finally {
            signal?.removeEventListener("abort", abort)
          }
        },
      })
      runtime.kernel.services.provide("vm.desktop", desktop.service)
      runtime.kernel.registerRoutes(desktop.routes)
      const endpoint = `http://127.0.0.1:${runtime.handshake.port}`
      const request = (path: string, body: unknown = {}) =>
        fetch(`${endpoint}/api/v1${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "desktop-local-test" },
          body: JSON.stringify(body),
        })
      const { bot } = (await (
        await request("/bots", { name: "Tela de teste", provider: "codex", machine: "vm", computerUse: false })
      ).json()) as { bot: Bot }
      await vite.listen()
      const viteAddress = vite.httpServer?.address()
      if (!viteAddress || typeof viteAddress === "string") throw new Error("Vite port missing")
      origin = `http://127.0.0.1:${viteAddress.port}`
      allowedOrigins.add(origin)
      guest = await chromium.launch({
        headless: false,
        env: { ...process.env, DISPLAY: display },
        args: ["--window-size=640,480", "--window-position=0,0"],
      })
      const guestPage = await guest.newPage()
      await guestPage.goto(
        `data:text/html,${encodeURIComponent('<textarea id="text" autofocus style="width:250px;height:80px"></textarea>')}`,
      )
      await guestPage.bringToFront()
      viewer = await chromium.launch({ headless: true })
      const page = await viewer.newPage({ viewport: { width: 1000, height: 800 } })
      const errors: Array<string> = []
      const desktopSessions: string[] = []
      page.on("response", async (response) => {
        if (!response.url().endsWith(`/bots/${bot.id}/desktop`) || !response.ok()) return
        const session = (await response.json()) as { sessionId: string }
        desktopSessions.push(session.sessionId)
      })
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${origin}/test/e2e/fixtures/desktop.html?endpoint=${encodeURIComponent(endpoint)}&bot=${bot.id}`)
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>("button[aria-pressed]")?.disabled === false,
        null,
        { timeout: 30_000 },
      )
      if (process.env.TOURI_SCREENSHOT_DIR) {
        mkdirSync(process.env.TOURI_SCREENSHOT_DIR, { recursive: true })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.screenshot({ path: join(process.env.TOURI_SCREENSHOT_DIR, "observe.png"), fullPage: true })
      }
      expect(statSync(passwordPath).mode & 0o777).toBe(0o600)
      expect(await attemptVnc(address.port)).toBe(false)
      expect(await attemptVnc(address.port, "wrong123")).toBe(false)
      expect(await attemptVnc(address.port, password)).toBe(true)
      const oldPassword = password
      password = "next1234"
      writeFileSync(`${passwordPath}.next`, vncPasswordFile(password), { mode: 0o600 })
      renameSync(`${passwordPath}.next`, passwordPath)
      expect(await attemptVnc(address.port, oldPassword)).toBe(false)
      expect(await attemptVnc(address.port, password)).toBe(true)
      expect(readFileSync(logPath, "utf8")).not.toContain(oldPassword)
      expect(readFileSync(logPath, "utf8")).not.toContain(password)
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      await page.waitForTimeout(9_000)
      expect(await page.getByRole("button", { name: "Assumir controle", exact: true }).isEnabled()).toBe(true)
      await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
      await page.getByRole("button", { name: "Devolver ao bot" }).waitFor()
      if (process.env.TOURI_SCREENSHOT_DIR) {
        await page.screenshot({ path: join(process.env.TOURI_SCREENSHOT_DIR, "control.png"), fullPage: true })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: join(process.env.TOURI_SCREENSHOT_DIR, "control-mobile.png"), fullPage: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
        await page.setViewportSize({ width: 1000, height: 800 })
      }
      await guestPage.bringToFront()
      await guestPage.locator("textarea").focus()
      await page.getByLabel("Digitar na VM").fill("Olá 日本")
      await browserExpect.poll(() => guestPage.locator("textarea").inputValue()).toBe("Olá 日本")
      await page.getByLabel("Digitar na VM").evaluate((textarea: HTMLTextAreaElement) => {
        textarea.dispatchEvent(new CompositionEvent("compositionstart"))
        textarea.value = "語"
        textarea.dispatchEvent(new InputEvent("input", { isComposing: true }))
        textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "語" }))
        textarea.value = "語"
        textarea.dispatchEvent(new InputEvent("input"))
      })
      await browserExpect.poll(() => guestPage.locator("textarea").inputValue()).toBe("Olá 日本語")
      await page.getByLabel("Digitar na VM").fill("😀")
      await browserExpect.poll(() => guestPage.locator("textarea").inputValue()).toBe("Olá 日本語😀")
      expect(pastes).toBe(3)
      await guestPage.evaluate(() => {
        document.body.dataset.clicked = "no"
        document.addEventListener("click", () => {
          document.body.dataset.clicked = "yes"
        })
      })
      const canvas = page.locator("canvas")
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error("Viewer canvas missing")
      await canvas.click({ position: { x: bounds.width / 4, y: bounds.height / 2 } })
      await browserExpect.poll(() => guestPage.evaluate(() => document.body.dataset.clicked)).toBe("yes")
      expect(runtime.kernel.services.use("computer.input")?.human(bot.id)).toBe(true)
      await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
      await browserExpect.poll(() => runtime.kernel.services.use("computer.input")?.human(bot.id)).toBe(false)
      await browserExpect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled()
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
      await page.getByRole("button", { name: "Devolver ao bot", exact: true }).waitFor()
      expect((await request("/computer/kill")).status).toBe(200)
      await page.getByRole("button", { name: "Reconectar tela" }).last().click()
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>("button[aria-pressed]")?.disabled === false,
      )
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      const beforeReconnect = desktopSessions.length
      const currentSession = desktopSessions.at(-1)
      if (!currentSession) throw new Error("Missing VNC session")
      desktop.service.close(currentSession, 1006)
      await browserExpect.poll(() => desktopSessions.length).toBe(beforeReconnect + 1)
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>("button[aria-pressed]")?.disabled === false,
      )
      expect(leases.at(-1)).toBe(true)
      expect(await page.getByLabel("Digitar na VM").isDisabled()).toBe(true)
      // Stop only our pulse: transport and RFB remain live, but rendered liveness must fail.
      heartbeat.kill("SIGSTOP")
      await page.getByRole("button", { name: "Reconectar tela" }).last().waitFor({ timeout: 15_000 })
      heartbeat.kill("SIGCONT")
      await page.getByRole("button", { name: "Reconectar tela" }).last().click()
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>("button[aria-pressed]")?.disabled === false,
      )
      vnc.kill("SIGSTOP")
      await page.getByRole("button", { name: "Reconectar tela" }).last().waitFor({ timeout: 15_000 })
      vnc.kill("SIGCONT")
      expect(errors).toEqual([])
      if (process.env.TOURI_SCREENSHOT_DIR) {
        await page.goto(`${origin}/test/e2e/fixtures/desktop.html?headless`)
        await page.getByRole("button", { name: "Conversar", exact: true }).waitFor()
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.screenshot({ path: join(process.env.TOURI_SCREENSHOT_DIR, "headless.png"), fullPage: true })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: join(process.env.TOURI_SCREENSHOT_DIR, "headless-mobile.png"), fullPage: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
        await page.getByRole("button", { name: "Abrir arquivos", exact: true }).click()
        expect(await page.locator("#root").getAttribute("data-action")).toBe("files")
      }
    } finally {
      // Resume only test-owned processes before teardown, even when a freeze assertion fails.
      for (const child of children) if (child.exitCode === null) child.kill("SIGCONT")
      await viewer?.close()
      await guest?.close()
      desktop?.service.dispose()
      await vm.dispose()
      runtime.emitHostNotification({ method: "app.willQuit", params: {} })
      runtime.stop()
      await vite.close()
      if (origin) allowedOrigins.delete(origin)
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL")
      await Promise.all(children.map((child) => child.exited))
      rmSync(root, { recursive: true, force: true })
    }
  },
  240_000,
)
