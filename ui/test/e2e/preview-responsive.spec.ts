import { expect, test } from "@playwright/test"
import { showBotDetails, showBotPanel } from "./home-navigation"

test.setTimeout(90_000)

const themes = ["light", "dark"]
const sizes = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
  { width: 900, height: 700 },
  { width: 390, height: 844 },
]

themes.forEach((theme) => {
  sizes.forEach((viewport) => {
    test(`preview controls · ${theme} · ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto("/test/e2e/screens-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)

      await showBotPanel(page)
      await showBotDetails(page)
      await page.getByRole("button", { name: "Preview do projeto", exact: true }).click()
      const start = page.getByRole("button", { name: "Subir tudo", exact: true })
      await expect(start).toBeVisible()
      await start.click()

      await expect(page.locator(".preview-process-row > i.ready")).toHaveCount(2)
      const logsTab = page.getByRole("tab", { name: "Logs", exact: true })
      await expect(logsTab).toBeVisible()
      await logsTab.click()
      await page.locator(".preview-process-row").first().click()

      await expect(page.getByRole("log")).toContainText("Servidor iniciado")
      const stop = page.locator(".preview-project-actions").getByRole("button", { name: "Parar", exact: true })
      await stop.click()

      await expect(page.locator(".preview-process-row > i.ready")).toHaveCount(0)
      await expect(start).toBeEnabled()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

      expect(overflow).toBe(0)
    })
  })
})
