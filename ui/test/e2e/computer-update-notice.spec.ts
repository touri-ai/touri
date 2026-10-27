import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const width of [1440, 390]) {
  for (const outcome of ["updated", "rolled-back"]) {
    test(`expanded computer keeps the ${outcome} notice visible at ${width}px`, async ({ page }, info) => {
      test.setTimeout(30_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })

      await page.goto(`/test/e2e/fixtures/desktop.html?notice=${outcome}`)

      const notice = page.locator(".computer-summary p[role='status']")
      await expect(notice).toHaveCount(1, { timeout: 15_000 })
      await page.screenshot({ path: info.outputPath(`computer-${outcome}-${width}.png`), fullPage: true })
      await expect(notice).toBeVisible()
      const noticeBounds = await notice.boundingBox()
      const openBounds = await page.getByRole("button", { name: "Acompanhar a tela", exact: true }).boundingBox()
      if (!noticeBounds || !openBounds) throw new Error("Computer notice or primary action is missing")
      if (width === 1440) expect(openBounds.y).toBeLessThan(noticeBounds.y)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const accessibility = await new AxeBuilder({ page }).include(".computer-summary").analyze()
      expect(accessibility.violations.filter((entry) => ["serious", "critical"].includes(entry.impact ?? ""))).toEqual(
        [],
      )
    })
  }
}
