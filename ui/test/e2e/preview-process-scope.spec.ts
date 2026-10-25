import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { showBotChat, showBotPanel } from "./home-navigation"

test.use({ reducedMotion: "reduce", colorScheme: "light" })

const widths = [390, 1440]
widths.forEach((width) => {
  test(`reselecting the VM bot keeps its project process controls at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/integrated-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
    if (await menu.isVisible()) await menu.click()

    await showBotChat(page)
    const sidebar = page.getByRole("dialog", { name: "Barra lateral", exact: true })
    if (await sidebar.isVisible()) await page.keyboard.press("Escape")
    await showBotPanel(page)
    await page.getByRole("button", { name: "Preview do projeto", exact: true }).click()
    await page.getByRole("tab", { name: "Logs", exact: true }).click()

    await expect(page.locator(".preview-process-row")).toHaveCount(2)
    await page.locator(".preview-process-row").first().click()
    await expect(page.getByRole("log", { name: "Logs do processo" })).toContainText("Servidor iniciado")
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      path: join(directory, `review-process-scope-${width}.png`),
      animations: "disabled",
      mask: [page.locator(".project-path"), page.locator(".composer-model")],
    })
  })
})
