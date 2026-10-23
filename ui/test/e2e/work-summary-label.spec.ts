import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390] as const) {
    test(`work stays reachable without a duplicate summary: ${theme}, ${width}px`, async ({ page }) => {
      test.setTimeout(45_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
      await page.goto("/test/e2e/work-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await expect(page.locator(".sidebar-work-badge")).toHaveCount(0)

      await openGlobalPage(page, "Trabalho")

      await expect(page.getByRole("heading", { name: "Trabalho", exact: true })).toBeVisible()
      await expect(page.getByRole("region", { name: "Trabalhando", exact: true }).getByRole("article")).toHaveCount(3)
      await expect(page.getByRole("region", { name: "Na fila", exact: true }).getByRole("article")).toHaveCount(2)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const audit = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze()
      expect(audit.violations).toEqual([])
    })
  }
}
