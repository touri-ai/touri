import AxeBuilder from "@axe-core/playwright"
import { expect, type Locator, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  test(`branded buttons preserve contrast throughout hover in ${theme}`, async ({ page }) => {
    await page.goto("/test/e2e/design-harness.html")
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    const buttons = page.locator(".brand-button-samples button")
    await expect(buttons).toHaveCount(2)
    // Keep transitions live until the test selects an exact frame, independent of browser speed.
    await buttons.evaluateAll((elements) => {
      elements.forEach((element) => {
        element.style.transitionDuration = "60s"
      })
    })

    for (const button of await buttons.all()) {
      await button.hover()
      await checkTransition(button)

      await page.mouse.move(0, 0)
      await checkTransition(button)
    }
  })
}

const checkTransition = async (button: Locator) => {
  expect(await button.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0)

  for (const progress of [0, 0.5, 1]) {
    await button.evaluate((element, value) => {
      element.getAnimations().forEach((animation) => {
        animation.pause()
        const duration = animation.effect?.getTiming().duration
        if (typeof duration === "number") animation.currentTime = duration * value
      })
    }, progress)

    const accessibility = await new AxeBuilder({ page: button.page() }).include(".brand-button-samples").analyze()
    expect(accessibility.violations).toEqual([])
  }
}
