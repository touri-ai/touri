import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

const widths = [1440, 390]

widths.forEach((width) => {
  test(`person takeover stays quiet at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/channel-takeover-harness.html?legacyTakeoverNotice=true")
    const composer = page.getByRole("textbox", { name: "Mensagem para Equipe de viagens" })
    await composer.fill("@Planejamento confira o portal de demonstração e me chame para entrar.")
    await composer.press("Enter")
    const browserCard = page.locator(".browser-activity-card").first()
    const takeover = browserCard.getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeVisible()

    await takeover.click()

    const control = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(control).toContainText("Você está no controle · Planejamento está pausado")
    await expect(control.getByRole("button", { name: "Devolver para Planejamento" })).toBeVisible()
    const evidenceDirectory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true })
      await writeFile(
        join(evidenceDirectory, `takeover-${width}.png`),
        await page.screenshot({ animations: "disabled" }),
      )
    }
    await expect(control.getByRole("button", { name: "Devolver para Planejamento" })).toBeInViewport()
    await expect(page.locator(".notice-bar")).toHaveCount(0)
  })
})
