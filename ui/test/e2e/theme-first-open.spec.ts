import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`a first opening follows a ${scheme} system at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto("/test/e2e/groups-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
      if (process.env.TOURI_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.TOURI_SCREENSHOT_DIR}/first-open-${scheme}-${viewport.width}.png`,
        })

      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme)
      expect(await page.evaluate(() => localStorage.getItem("touri.appearance.v1"))).toBeNull()
    })
  }

  test(`an explicit dark choice stays dark on a light system at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: "light" })
    await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "dark"))
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.emulateMedia({ colorScheme: "dark" })
    await page.emulateMedia({ colorScheme: "light" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  })
}
