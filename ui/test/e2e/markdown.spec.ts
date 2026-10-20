import { mkdir } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const phase = process.env.MARKDOWN_PHASE ?? "after"
for (const theme of ["light", "dark"]) {
  for (const view of ["segments", "history"]) {
    test(`${phase} ${view} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 1250 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(`/test/e2e/markdown-harness.html?view=${view}&theme=${theme}`)
      await expect(page.locator(".markdown-content")).toBeVisible()
      if (phase === "after") {
        await expect(page.getByRole("table")).toBeVisible()
        expect(await page.locator(".markdown-content > p").count()).toBeGreaterThan(5)
      }
      await expect(page.locator(".tool-card")).toHaveCount(3)
      for (const trigger of await page.locator(".tool-details > .ds-disclosure-trigger").all()) {
        await trigger.click()
      }
      if (phase === "after") {
        await expect(page.locator('[data-call-id="failure"] .tool-output code[data-highlighted="true"]')).toBeVisible()
        await expect(page.locator(".tool-exit-chip")).toHaveCount(2)
        const accessibility = await new AxeBuilder({ page })
          .include(".markdown-content")
          .include(".tool-card")
          .withRules(["color-contrast"])
          .analyze()
        expect(accessibility.violations).toEqual([])
      }
      await page.evaluate(() => document.fonts.ready)
      await mkdir("../docs/qa/r10/markdown", { recursive: true })
      await page.screenshot({ path: `../docs/qa/r10/markdown/${phase}-${view}-${theme}.png`, fullPage: true })
      if (phase === "after" && view === "segments") {
        await page.setViewportSize({ width: 1100, height: 2400 })
        const fullContrast = await new AxeBuilder({ page })
          .include(".harness-tools")
          .withRules(["color-contrast"])
          .analyze()
        expect(fullContrast.violations).toEqual([])
        await page
          .locator(".harness-tools")
          .screenshot({ path: `../docs/qa/r10/markdown/${phase}-terminal-${theme}.png` })
        await page.setViewportSize({ width: 390, height: 1250 })
        const table = page.getByRole("region", { name: "Tabela da mensagem" })
        expect(await table.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
        await table.focus()
        await page.keyboard.press("ArrowRight")
        await expect.poll(() => table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)
        expect(await page.locator(".message-assistant").evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0)
      }
    })
  }
}
