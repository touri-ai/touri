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
    test(`one failure surface · ${theme} · ${viewport.width}`, async ({ page }, info) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto("/test/e2e/error-contract-harness.html?fixtureComputer=healthy")
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const card = page.locator(".message-error").first()
      await expect(card).toBeVisible()
      await page.waitForTimeout(1200)

      await expect(page.getByRole("button", { name: /^Tentar (novamente|de novo)$/ })).toHaveCount(1)
      await expect(page.getByText("Detalhes do erro")).toHaveCount(1)
      await expect(page.locator(".notice-bar.notice-error")).toHaveCount(0)
      await expect(page.locator(".composer-notice")).toHaveCount(0)
      await expect(card.getByRole("button", { name: "Tentar novamente", exact: true })).toBeInViewport({ ratio: 1 })
      await page.locator(".chat-panel").screenshot({
        path: info.outputPath(`healthy-${theme}-${viewport.width}.png`),
        mask: [page.locator(".composer-model")],
      })
    })
  })
})
