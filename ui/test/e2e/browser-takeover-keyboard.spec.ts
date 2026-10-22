import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { chromium, expect, type Page, test } from "@playwright/test"

const token = randomUUID()
let child: ChildProcess
let endpoint = ""

test.beforeAll(async ({ baseURL }) => {
  const fixtureBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? baseURL
  if (!fixtureBaseUrl) throw new Error("The local browser fixture URL is missing.")
  const fixtureUrl = new URL("/test/e2e/fixtures/travel-search.html", fixtureBaseUrl).toString()
  child = spawn("bun", [resolve("test/e2e/browser-activity-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TOURI_CHROME_BIN: chromium.executablePath(),
      TOURI_BROWSER_HEADLESS: "1",
      TOURI_BROWSER_FLOW_TOKEN: token,
      TOURI_BROWSER_FLOW_FIXTURE_URL: fixtureUrl,
    },
  })
  await new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("The local browser fixture did not start.")), 20_000)
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    lines.on("line", (line) => {
      if (!line.startsWith("BROWSER_ACTIVITY_FIXTURE:")) return
      endpoint = `http://127.0.0.1:${Number(line.split(":")[1])}`
      clearTimeout(timeout)
      accept()
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error("The local browser fixture exited."))
    })
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      done()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      done()
    })
    child.kill("SIGTERM")
  })
})

const connectBrowserFixture = async (page: Page): Promise<void> => {
  await page.route("**/__browser-activity-fixture", async (route) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: route.request().postData() ?? "{}",
      signal: AbortSignal.timeout(10_000),
    })
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() })
  })
}

const keyboardWidths = [1440, 390]

keyboardWidths.forEach((width) => {
  test(`remote keyboard input reaches the managed page without entering the conversation at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await connectBrowserFixture(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/browser-activity-harness.html?flow=live&holdAfterOpen=true")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    const takeOver = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeOver).toBeEnabled({ timeout: 40_000 })
    await takeOver.click()
    const control = page.getByRole("region", { name: "Controle remoto do navegador" })
    await control.getByRole("button", { name: "Expandir navegador em tela cheia" }).click()
    const screen = control.locator(".browser-takeover-screen")
    await expect(screen.locator("canvas:visible, img").first()).toBeVisible()
    await expect(control.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
    const target = await page.evaluate(async () => {
      const response = await fetch("/__browser-activity-fixture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "private-target" }),
      })
      return response.json() as Promise<{ x: number; y: number; width: number; height: number } | null>
    })
    const bounds = await screen.boundingBox()
    if (!target || !bounds) throw new Error("The managed input fixture is missing")
    const scale = Math.min(bounds.width / target.width, bounds.height / target.height)

    await screen.click({
      position: {
        x: (bounds.width - target.width * scale) / 2 + target.x * scale,
        y: (bounds.height - target.height * scale) / 2 + target.y * scale,
      },
    })
    await control.getByRole("button", { name: "Digitar no navegador" }).click()
    const evidence = process.env.TOURI_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `browser-keyboard-${width}.png`), fullPage: true })
    }
    await expect(control.getByRole("textbox", { name: "Entrada de teclado para o navegador" })).toBeFocused()
    const focusedPage = await page.evaluate(async () => {
      const response = await fetch("/__browser-activity-fixture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "private-input-status" }),
      })
      return (await response.json()) as {
        activeTag: string | null
        activeLabel: string | null
        activeId: string | null
      }
    })
    expect(focusedPage).toMatchObject({ activeTag: "INPUT", activeLabel: "Destination primary" })

    await page.keyboard.insertText("entrada privada fictícia")
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const response = await fetch("/__browser-activity-fixture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ step: "stats" }),
          })
          return (await response.json()) as { takeoverInputAttempts: number; takeoverInputCount: number }
        }),
      )
      .toMatchObject({ takeoverInputAttempts: 2, takeoverInputCount: 2 })
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const response = await fetch("/__browser-activity-fixture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ step: "private-input-status" }),
          })
          return ((await response.json()) as { received: boolean }).received
        }),
      )
      .toBe(true)

    await expect(page.getByTestId("virtual-message-list")).not.toContainText("entrada privada fictícia")
    if (!evidence)
      await page.screenshot({ path: test.info().outputPath(`browser-private-input-${width}.png`), fullPage: true })
    await control.getByRole("button", { name: /Devolver para/ }).click()
    await page.getByRole("button", { name: "Parar Lia" }).click()
  })
})
