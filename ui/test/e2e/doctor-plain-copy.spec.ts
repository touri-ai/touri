import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`doctor plain copy at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
      await page.addInitScript((preference) => localStorage.setItem("touri.appearance.v1", preference), theme)
      await page.goto("/test/e2e/home-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      if (width < 600) await page.getByRole("button", { name: "Abrir menu" }).click()
      await openGlobalPage(page, "Verificar este Mac")
      const dialog = page.getByRole("dialog", { name: "Verificar suas ferramentas" })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Importar bots do app anterior" })).toHaveCount(0)
      await expect(dialog.getByText("Codex está instalado")).toBeVisible()
      await expect(dialog.getByText("Claude está instalado")).toBeVisible()
      const details = dialog.getByRole("button", { name: "Detalhes técnicos" }).first()
      await expect(details).toHaveAttribute("aria-expanded", "false")
      await details.click()
      await expect(details).toHaveAttribute("aria-expanded", "true")
      await expect(dialog.getByText("codex · versão")).toBeVisible()
      await details.click()
      await expect(dialog.getByText("codex · versão")).not.toBeVisible()
      await expect(dialog.getByRole("button", { name: "Concluído" })).toBeEnabled()
      const violations = await new AxeBuilder({ page }).include(".doctor-modal").analyze()
      expect(violations.violations).toEqual([])
    })
  }
}
