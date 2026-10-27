import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { expect, test } from "@playwright/test"

const enabled = Boolean(process.env.TOURI_TERMINAL_DOCKER)
let child: ChildProcess | undefined
let endpoint = ""
let botId = ""

test.skip(!enabled, "Set TOURI_TERMINAL_DOCKER to a Docker executable with the current bot image built")
test.use({ channel: "chromium" })
test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(240_000)
  const port = await getStagingPort()
  child = spawn("bun", [resolve("test/e2e/computer-terminal-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { TOURI_TERMINAL_ORIGIN: baseURL, TOURI_TERMINAL_PORT: String(port) }),
  })
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Terminal computer did not start")), 180_000)
    if (!child?.stdout) throw new Error("Missing terminal fixture output")
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      if (!line.startsWith("TERMINAL_FIXTURE:")) return
      const parts = line.split(":")
      endpoint = `http://127.0.0.1:${parts[1]}`
      botId = parts[2] ?? ""
      clearTimeout(timer)
      accept()
    })
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Terminal fixture exited"))
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
  test(`real desktop terminal accepts commands, accents and paste at ${width}px`, async ({ page }, info) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(
      `/test/e2e/fixtures/desktop.html?computer&running&endpoint=${encodeURIComponent(endpoint)}&bot=${botId}`,
    )
    const takeover = page.getByRole("button", { name: "Assumir controle", exact: true })
    await expect(takeover).toBeEnabled({ timeout: 60_000 })
    await takeover.click()
    await expect(page.getByLabel("Digitar na VM")).toBeEnabled({ timeout: 30_000 })
    if (process.env.TOURI_TERMINAL_PREVIOUS_IMAGE) {
      await expect(page.getByText("Computador atualizado: agora com Terminal e Arquivos")).toBeVisible()
      expect(await getEvidence({ command: "upgrade-proof" })).toBe(
        'workspace preservedhome preservedprofile preserved{"session":{"restore_on_startup":1}}',
      )
    }
    await page.screenshot({
      path: process.env.TOURI_TERMINAL_EVIDENCE
        ? join(process.env.TOURI_TERMINAL_EVIDENCE, `terminal-before-${width}.png`)
        : info.outputPath(`terminal-before-${width}.png`),
      fullPage: true,
    })
    const terminals = (await getEvidence({ action: "windows" })).trim().split("\n").length
    expect(terminals).toBeGreaterThan(0)

    // Click the persistent dock's Terminal launcher through the real streamed canvas.
    const canvas = page.locator(".desktop-canvas canvas")
    const rect = await canvas.boundingBox()
    if (!rect) throw new Error("Missing desktop canvas")
    await canvas.click({ position: { x: rect.width * 0.474, y: rect.height * 0.958 } })
    await expect
      .poll(async () => (await getEvidence({ action: "windows" })).trim().split("\n").length)
      .toBeGreaterThan(terminals)
    const keyboard = page.getByLabel("Digitar na VM")
    await keyboard.fill(`printf 'Olá, ação ç ~ ^ @! ${width}\\n' > ~/terminal-proof.txt`)
    await keyboard.press("Enter")
    await expect.poll(() => getProof(), { timeout: 15_000 }).toContain(`Olá, ação ç ~ ^ @! ${width}`)
    await keyboard.press("Control+c")
    await expect(page.getByRole("textbox")).toHaveCount(1)
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      "printf 'colado\\n' >> ~/terminal-proof.txt; cat ~/terminal-proof.txt",
    )
    const pasted = page.waitForResponse(
      (response) => response.url().endsWith("/text") && response.request().method() === "POST",
    )
    await keyboard.press(width === 390 ? "Control+Shift+v" : "Control+v")
    expect((await pasted).ok()).toBe(true)
    await keyboard.press("Enter")
    await expect.poll(() => getProof()).toContain("colado")
    if (width === 390) {
      await page.getByRole("button", { name: "Ampliar tela", exact: true }).click()
      await expect(page.getByRole("button", { name: "Ajustar à tela", exact: true })).toBeVisible()
    }
    await page.screenshot({
      path: process.env.TOURI_TERMINAL_EVIDENCE
        ? join(process.env.TOURI_TERMINAL_EVIDENCE, `terminal-after-${width}.png`)
        : info.outputPath(`terminal-after-${width}.png`),
      fullPage: true,
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
    await expect(keyboard).toBeDisabled()
  })
}

const getProof = async (): Promise<string> => {
  return getEvidence({ command: "cat /workspace/.home/terminal-proof.txt" })
}

const getEvidence = async (body: { action?: string; command?: string }): Promise<string> => {
  const response = await fetch(`${endpoint}/api/v1/terminal-evidence`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const result = (await response.json()) as { stdout?: string }

  return result.stdout ?? ""
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
