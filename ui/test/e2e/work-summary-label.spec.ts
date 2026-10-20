import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

const themes = ["light", "dark"] as const
const widths = [1440, 390] as const

themes.forEach((theme) => {
  widths.forEach((width) => {
    test(`work summary label: ${theme}, ${width}px`, async ({ page }, info) => {
      test.setTimeout(45_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
      await page.goto("/test/e2e/work-harness.html")
      await page.waitForLoadState("networkidle")
      await page.reload({ waitUntil: "networkidle" })
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      const badge = page.locator(".sidebar-work-badge:visible")
      await expect(
        page.getByRole("button", { name: "Trabalhando · 3 2 na fila Ver trabalho", exact: true }),
      ).toBeVisible()
      const label = await badge.getAttribute("aria-label")
      expect(label).toBeNull()
      if (theme === "light" && width === 1440) {
        await badge.screenshot({ path: info.outputPath("work-summary-before.png") })
      }

      await badge.evaluate((element) => element.setAttribute("aria-label", "Ver trabalho: 3 em execução, 2 na fila"))
      const baseline = await getLabelAudit(page)

      expect(baseline.violations.map((rule) => rule.id)).toEqual(["label-content-name-mismatch"])
      expect(baseline.incomplete).toEqual([])

      await badge.evaluate((element) => element.removeAttribute("aria-label"))
      const fixed = await getLabelAudit(page)

      expect(fixed.violations).toEqual([])
      expect(fixed.incomplete).toEqual([])
      expect(fixed.passes).toEqual([])
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await badge.screenshot({ path: info.outputPath(`work-summary-${theme}-${width}.png`) })

      await badge.click()

      await expect(page.getByRole("heading", { name: "Trabalho", exact: true })).toBeVisible()
    })
  })
})

const getLabelAudit = (page: Page) =>
  new AxeBuilder({ page }).include(".sidebar-work-badge").withRules(["label-content-name-mismatch"]).analyze()
