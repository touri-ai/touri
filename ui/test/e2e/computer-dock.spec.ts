import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { expect, type Page, test } from "@playwright/test"

const enabled = Boolean(process.env.TOURI_DOCK_DOCKER)
let child: ChildProcess | undefined
let endpoint = ""
let botId = ""

test.skip(!enabled, "Set TOURI_DOCK_DOCKER with the current bot image built")
test.use({ channel: "chromium" })
test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(240_000)
  const port = await getStagingPort()
  child = spawn("bun", [resolve("test/e2e/computer-dock-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { TOURI_DOCK_ORIGIN: baseURL, TOURI_DOCK_PORT: String(port) }),
  })
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Dock computer did not start")), 180_000)
    if (!child?.stdout) throw new Error("Missing dock fixture output")
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      if (!line.startsWith("DOCK_FIXTURE:")) return
      const parts = line.split(":")
      endpoint = `http://127.0.0.1:${parts[1]}`
      botId = parts[2] ?? ""
      clearTimeout(timer)
      accept()
    })
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Dock fixture exited"))
    })
  })
})
test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const current = child
  await new Promise<void>((done) => {
    current.once("exit", () => done())
    current.kill("SIGTERM")
  })
})

for (const width of [1440, 390]) {
  test(`real dock opens and focuses the shared browser at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(
      `/test/e2e/fixtures/desktop.html?computer&running&endpoint=${encodeURIComponent(endpoint)}&bot=${botId}`,
    )
    await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
    const keyboard = page.getByLabel("Digitar na VM")
    await expect(keyboard).toBeEnabled({ timeout: 30_000 })
    await page.screenshot({ path: info.outputPath(`dock-${width}.png`), fullPage: true })

    await clickBrowser(page)

    await expect.poll(async () => (await getEvidence("windows")).stdout?.trim(), { timeout: 30_000 }).toMatch(/^\d+/)
    const window = (await getEvidence("windows")).stdout?.trim()
    await keyboard.press("Control+l")
    await keyboard.fill("http://127.0.0.1:18880/person")
    await keyboard.press("Enter")
    await expect.poll(async () => (await getEvidence("browser-state")).targetId, { timeout: 20_000 }).toBeTruthy()
    await keyboard.press("Tab")
    await keyboard.press("Enter")
    await expect.poll(async () => (await getEvidence("browser-state")).state).toBe("preservado")
    const original = await getEvidence("browser-state")
    await page.screenshot({ path: info.outputPath(`browser-open-${width}.png`), fullPage: true })

    await getEvidence("minimize")
    await clickBrowser(page)

    await expect.poll(async () => (await getEvidence("active")).stdout?.trim()).toBe(window)
    const focused = await getEvidence("browser-state")
    expect(focused.targetId).toBe(original.targetId)
    expect(focused.pages).toBe(original.pages)
    expect(focused.state).toBe("preservado")
    if (width === 390) {
      await clickBrowserAtPhoneScale(page, info.outputPath("dock-phone-100-percent.png"))
      expect((await getEvidence("browser-state")).targetId).toBe(original.targetId)
    }
    const denied = await getEvidence("security")
    expect(JSON.parse(denied.stdout ?? "{}")).toEqual({ authority: true, profile: true, control: true, launcher: true })
    await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
    await expect(keyboard).toBeDisabled()

    const tools = await getEvidence("bot-tools")

    expect(tools.tabs?.success).toBe(true)
    expect(tools.screenshot).toBe(true)
    expect(tools.click).toBe(true)
    expect(tools.opened).toBe(true)
    expect((await getEvidence("browser-state")).state).toBe("preservado")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

const clickBrowser = async (page: Page) => {
  const geometry = (await getEvidence("panel")).stdout ?? ""
  const values = Object.fromEntries(
    geometry
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  )
  const canvas = page.locator(".desktop-canvas canvas")
  const rect = await canvas.boundingBox()
  if (!rect) throw new Error("Missing desktop canvas")
  await canvas.click({
    position: { x: ((Number(values.X) + 38) / 1440) * rect.width, y: ((Number(values.Y) + 34) / 900) * rect.height },
  })
}

const clickBrowserAtPhoneScale = async (page: Page, screenshot: string) => {
  await page.getByRole("button", { name: "Ampliar tela", exact: true }).click()
  const canvas = page.locator(".desktop-canvas canvas")
  const rect = await canvas.boundingBox()
  if (!rect) throw new Error("Missing zoomed desktop canvas")
  const offsetX = (1440 - rect.width) / 2
  const offsetY = 900 - rect.height
  const steps = 4
  for (const _step of Array.from({ length: steps })) {
    await page.mouse.move(rect.x + rect.width - 12, rect.y + rect.height - 12)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width - 12 - offsetX / steps, rect.y + rect.height - 12 - offsetY / steps, {
      steps: 6,
    })
    await page.mouse.up()
  }
  const geometry = (await getEvidence("panel")).stdout ?? ""
  const values = Object.fromEntries(
    geometry
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  )
  await canvas.click({ position: { x: Number(values.X) + 38 - offsetX, y: Number(values.Y) + 34 - offsetY } })
  await page.screenshot({ path: screenshot, fullPage: true })
  await page.getByRole("button", { name: "Ajustar à tela", exact: true }).click()
}

type Evidence = {
  stdout?: string
  targetId?: string
  state?: string
  pages?: number
  tabs?: { success: boolean }
  screenshot?: boolean
  click?: boolean
  opened?: boolean
}
const getEvidence = async (action: string): Promise<Evidence> => {
  const response = await fetch(`${endpoint}/api/v1/dock-evidence`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(30_000),
  })

  return response.json()
}

const getStagingPort = async (): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const available = await new Promise<boolean>((resolvePort) => {
      const server = createServer()
      server.once("error", () => resolvePort(false))
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)))
    })
    if (available) return port
  }

  throw new Error("No free staging port")
}
