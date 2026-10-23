import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

for (const width of [1440, 390]) {
  test(`session recovery explains the automatic retry at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })

    await page.goto("/test/e2e/r8-chat-harness.html?view=session-recovery&theme=light")

    await expect(
      page.getByText(
        "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão.",
      ),
    ).toBeVisible()
    await expect(page.getByText("Relatório concluído. Conferi o trabalho salvo antes de continuar.")).toBeVisible()
    await expect(page.getByText("Etapa inicial salva.")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const directory = resolve(import.meta.dirname, "../../../docs/evidence/restart-session")
    await mkdir(directory, { recursive: true })
    const path = resolve(directory, `recovery-${width}.png`)
    await page.screenshot({ path, animations: "disabled" })
    await info.attach("Visible session recovery", { path, contentType: "image/png" })
  })
}
