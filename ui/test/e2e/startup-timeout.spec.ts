import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

for (const width of [1440, 390]) {
  test(`startup failure replaces the waiting state with a retry action at ${width}`, async ({ page }) => {
    const directory = process.env.TOURI_STARTUP_SCREENSHOT_DIR
    if (directory) await mkdir(directory, { recursive: true })
    const getScreenshotPath = (name: string) => (directory ? join(directory, name) : test.info().outputPath(name))
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.clock.install()
    await page.goto("/test/e2e/response-feedback-harness.html")
    await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Organize minhas notas em uma lista.")
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await page.clock.fastForward(300)
    await page.evaluate("window.feedback.provider()")
    await expect(page.locator(".activity-mark")).toBeVisible()
    if (width === 1440) await expect(page.getByText("Trabalhando · 1", { exact: true })).toBeVisible()
    await page.screenshot({
      path: getScreenshotPath(`starting-${width}.png`),
      mask: [page.locator(".composer-model")],
      maskColor: "#222",
    })

    await page.clock.fastForward(120_000)
    await page.evaluate("window.feedback.timeout()")

    await expect(page.locator(".activity-mark")).toHaveCount(0)
    await expect(page.getByRole("alert").locator(".error-notice > p")).toBeVisible()
    await expect(page.getByRole("alert").locator(".error-notice > p")).toHaveText("Sem resposta após 2 minutos.")
    await expect(page.getByRole("button", { name: /Tentar novamente/i })).toBeVisible()
    await expect(page.getByText(/Trabalhando · [1-9]/)).toHaveCount(0)
    await page.screenshot({
      path: getScreenshotPath(`failed-${width}.png`),
      mask: [page.locator(".composer-model")],
      maskColor: "#222",
    })
  })
}
