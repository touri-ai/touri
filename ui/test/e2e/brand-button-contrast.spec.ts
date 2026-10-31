import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  test(`branded buttons preserve contrast throughout hover in ${theme}`, async ({ page }) => {
    await page.goto("/test/e2e/design-harness.html")
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    const buttons = page.locator(".brand-button-samples button")

    for (const button of await buttons.all()) {
      await button.hover()
      await button.evaluate((element) => {
        element.getAnimations().forEach((animation) => {
          animation.pause()
          const duration = animation.effect?.getTiming().duration
          if (typeof duration === "number") animation.currentTime = duration / 2
        })
      })

      const accessibility = await new AxeBuilder({ page }).include(".brand-button-samples").analyze()
      expect(accessibility.violations).toEqual([])
    }
  })
}
