import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const scenario of ["session-recovery", "session-recovery-inline"]) {
  for (const width of [1440, 390]) {
    test(`${scenario} explains the automatic retry at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })

      await page.goto(`/test/e2e/r8-chat-harness.html?view=${scenario}&theme=light`)
      const transcript = page.getByTestId("virtual-message-list")

      await expect(
        transcript.getByText(
          "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão.",
        ),
      ).toBeVisible()
      await expect(
        transcript.getByText("Relatório concluído. Conferi o trabalho salvo antes de continuar."),
      ).toBeVisible()
      await expect(transcript.getByRole("paragraph").filter({ hasText: /^Etapa inicial salva\.$/ })).toBeVisible()
      await expect(transcript.getByRole("note")).toHaveCount(1)
      await page.evaluate(() => document.fonts.ready)
      const accessibility = await new AxeBuilder({ page }).include(".run-resumed-marker").analyze()
      expect(accessibility.violations).toEqual([])
      const directory = resolve(import.meta.dirname, "../../../docs/evidence/restart-session")
      await mkdir(directory, { recursive: true })
      const path = resolve(directory, `${scenario}-${width}.png`)
      await page.screenshot({ path, animations: "disabled" })
      await info.attach("Visible session recovery", { path, contentType: "image/png" })
    })
  }
}
