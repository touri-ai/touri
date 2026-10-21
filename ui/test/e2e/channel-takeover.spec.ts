import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({
  channel: "chromium",
  video: "on",
  reducedMotion: "reduce",
  viewport: { width: 1440, height: 900 },
})

test("a channel browser handback resumes the bot and posts its answer in the same thread", async ({ page }, info) => {
  test.setTimeout(180_000)
  await page.goto("/test/e2e/channel-takeover-harness.html")

  const composer = page.getByRole("textbox", { name: "Mensagem para Equipe de viagens" })
  await expect(composer).toBeVisible()
  await composer.fill("Confira o portal de demonstração e continue depois do login.")
  await composer.press("Enter")

  await expect(page.getByText("O portal de demonstração pediu login para continuar.")).toBeVisible()
  const pendingRequest = page.getByRole("button", { name: "Abrir pendência de Planejamento", exact: true })
  await expect(pendingRequest).toBeVisible()
  await pendingRequest.click()
  const browserCard = page.locator(".browser-activity-card").first()
  await expect(browserCard).toBeVisible()
  await expect(browserCard.getByRole("button", { name: "Assumir" })).toBeVisible()
  await expect(browserCard).toContainText("portal.example.test")

  const saveScreenshot = async (name: string): Promise<void> => {
    const screenshot = await page.screenshot({ fullPage: true })
    await writeFile(info.outputPath(name), screenshot)
    const evidenceDirectory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (!evidenceDirectory) return

    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(join(evidenceDirectory, name), screenshot)
  }

  await browserCard.getByRole("button", { name: "Assumir" }).click()
  const control = page.getByRole("region", { name: "Controle remoto do navegador" })
  await expect(control).toContainText("Você está no controle · Planejamento está pausado")
  await expect(browserCard.getByRole("button", { name: "Devolver para Planejamento" })).toBeVisible()
  await saveScreenshot("channel-takeover-active.png")

  await browserCard.getByRole("button", { name: "Devolver para Planejamento" }).click()
  await expect(control).toHaveCount(0)
  await expect(page.locator(".browser-activity-card")).toHaveCount(1)
  await expect(
    page.getByTestId("virtual-message-list").getByText("Retomado após a devolução do navegador", { exact: true }),
  ).toHaveCount(0)
  await expect(page.locator(".composer-browser-status")).toContainText("Planejamento está trabalhando · No navegador")
  await page.evaluate(() => (window as Window & { completeChannelResume?: () => void }).completeChannelResume?.())
  await expect(
    page
      .getByTestId("virtual-message-list")
      .getByText("O portal de demonstração está pronto para continuar.", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Cancelado por você", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Falhou", { exact: true })).toHaveCount(0)
  await saveScreenshot("channel-takeover-resumed.png")
})
