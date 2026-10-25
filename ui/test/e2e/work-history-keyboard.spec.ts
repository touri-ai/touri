import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const width of [1440, 390]) {
  test(`saved conversation supports Tab and keyboard scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/test/e2e/chat-image-harness.html?theme=dark")
    const history = page.getByRole("region", { name: "Histórico da conversa" })
    await expect(history).toBeVisible()
    await expect(history.locator(".evidence-gallery img")).toHaveCount(2)
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const initialScroll = await history.evaluate((element) => element.scrollTop)

    await page.keyboard.press("Tab")

    await expect(history).toBeFocused()
    await page.keyboard.press("PageUp")
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeLessThan(initialScroll)
    const accessibility = await new AxeBuilder({ page })
      .include(".message-scroll")
      .withRules(["scrollable-region-focusable"])
      .analyze()
    expect(accessibility.violations).toEqual([])
  })
}
