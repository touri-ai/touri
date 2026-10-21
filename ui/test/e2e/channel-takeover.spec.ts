import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({
  channel: "chromium",
  reducedMotion: "reduce",
  viewport: { width: 1440, height: 900 },
})

test("a channel browser handback resumes the bot and posts its answer in the same thread", async ({ page }, info) => {
  test.setTimeout(180_000)
  await page.goto("/test/e2e/channel-takeover-harness.html")

  const composer = page.getByRole("textbox", { name: "Mensagem para Equipe de viagens" })
  const messages = page.getByTestId("virtual-message-list")
  const saveScreenshot = async (name: string, sidebarOnly = false): Promise<void> => {
    const screenshot = sidebarOnly
      ? await page.locator(".bot-sidebar").screenshot({ animations: "disabled" })
      : await page.screenshot({ fullPage: true, animations: "disabled" })
    await writeFile(info.outputPath(name), screenshot)
    const evidenceDirectory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (!evidenceDirectory) return

    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(join(evidenceDirectory, name), screenshot)
  }

  await expect(composer).toBeVisible()
  await composer.fill("Confira o portal de demonstração e continue depois do login.")
  await composer.press("Enter")

  await expect(messages.getByText("O portal de demonstração pediu login para continuar.")).toBeVisible()
  await page.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
  await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
  await expect(page.locator(".browser-activity-card")).toHaveCount(0)
  await expect(page.locator(".sidebar-needs-you")).toHaveCount(0)
  await expect(page.locator('[data-bot-entry="bot-mark"] .bot-preview')).toContainText("Aguardando você: sua ajuda")
  const requestCue = page.getByRole("button", { name: "Abrir pendência de Planejamento" })
  await expect(page.locator('[data-bot-entry="bot-mark"] .sidebar-attention-button')).toHaveCount(1)
  await expect(requestCue).toBeVisible()
  await saveScreenshot("channel-takeover-sidebar-before.png", true)
  await requestCue.click()
  const browserCard = page.locator(".browser-activity-card").first()
  await expect(browserCard).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(browserCard.getByRole("button", { name: "Assumir controle" })).toBeVisible()
  await expect(browserCard).toContainText("portal.example.test/login")
  await saveScreenshot("channel-takeover-browser-card-after.png")

  await browserCard.getByRole("button", { name: "Assumir controle" }).click()
  await expect(browserCard.getByRole("status")).toContainText("Você está no controle desta aba do navegador.")
  await expect(browserCard.getByRole("button", { name: "Devolver para Planejamento" })).toBeVisible()
  await saveScreenshot("channel-takeover-active.png")

  await browserCard.getByRole("button", { name: "Devolver para Planejamento" }).click()
  await expect(browserCard.getByRole("status")).toContainText("Planejamento voltou a trabalhar")
  await expect(page.locator(".browser-activity-card")).toHaveCount(1)
  await expect(messages.getByText("Retomado após a devolução do navegador", { exact: true })).toBeVisible()
  await expect(page.locator(".composer-browser-status")).toContainText("Planejamento está trabalhando · No navegador")
  await page.evaluate(() => (window as Window & { completeChannelResume?: () => void }).completeChannelResume?.())
  await expect(
    messages.getByText("O portal de demonstração está pronto para continuar.", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Cancelado por você", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Falhou", { exact: true })).toHaveCount(0)
  await expect(page.locator(".browser-activity-card")).toHaveCount(1)
  await expect(browserCard).toContainText("Usou o navegador · 2 ações")
  await saveScreenshot("channel-takeover-resumed.png")
})
