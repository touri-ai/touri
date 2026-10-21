import { join } from "node:path"
import { expect, test } from "@playwright/test"

const variants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", locale: "pt-BR" },
  { name: "desktop-light", width: 1440, height: 900, theme: "light", locale: "pt-BR" },
  { name: "phone-dark", width: 390, height: 844, theme: "dark", locale: "pt-BR" },
  { name: "phone-light", width: 390, height: 844, theme: "light", locale: "pt-BR" },
  { name: "desktop-english", width: 1440, height: 900, theme: "light", locale: "en" },
] as const

test.use({ reducedMotion: "reduce" })

for (const variant of variants) {
  test(`browser card visual evidence: ${variant.name}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: variant.width, height: variant.height })
    await page.goto(`/test/e2e/browser-activity-harness.html?theme=${variant.theme}&locale=${variant.locale}`)
    const getScreenshotPath = (name: string) =>
      process.env.TOURI_E2E_EVIDENCE_DIR ? join(process.env.TOURI_E2E_EVIDENCE_DIR, name) : info.outputPath(name)
    const english = variant.locale === "en"
    await page.getByRole("button", { name: english ? "Start travel search" : "Iniciar busca de viagem" }).click()
    const card = page.locator(".browser-activity-card")
    await expect(
      card.getByRole("img", { name: english ? "Current browser page" : "Página atual do navegador" }),
    ).toBeVisible()
    await page.screenshot({ path: getScreenshotPath(`live-${variant.name}.png`), fullPage: true })

    await page.getByRole("button", { name: english ? "Search trips" : "Buscar viagens" }).click()

    await expect(card.getByRole("button", { name: /Used the browser|Usou o navegador/ })).toBeVisible()
    await page.screenshot({ path: getScreenshotPath(`finished-${variant.name}.png`), fullPage: true })
  })
}
