import { expect, test } from "@playwright/test"

test.setTimeout(90_000)

const themes = ["light", "dark"]
const sizes = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
  { width: 390, height: 844 },
]

themes.forEach((theme) => {
  sizes.forEach((viewport) => {
    test(`recovery layout · ${theme} · ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto("/test/e2e/error-contract-harness.html")
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      const notice = page.getByRole("complementary", { name: "Aviso do computador" })
      const details = notice.getByText("Detalhes do erro")
      const retry = notice.getByRole("button", { name: "Tentar novamente", exact: true })
      await expect(notice).toBeVisible()

      await expect(details).toHaveCount(1)
      await expect(notice.locator("code")).not.toBeVisible()
      await retry.click({ trial: true })
      if (viewport.width > 620) return
      const copyBox = await notice.locator(".composer-notice-copy").boundingBox()
      const actionBox = await retry.boundingBox()
      if (!copyBox || !actionBox) throw new Error("Recovery geometry unavailable")

      expect(copyBox.width).toBeGreaterThan(300)
      expect(actionBox.y).toBeGreaterThanOrEqual(copyBox.y + copyBox.height)
      await expect(retry).toBeInViewport({ ratio: 1 })
    })
  })
})
