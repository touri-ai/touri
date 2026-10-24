import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } })

test("taking control keeps the browser card visible without a legacy takeover toast", async ({ page }) => {
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
  await expect(page.locator(".notice-bar")).toHaveCount(0)
})
