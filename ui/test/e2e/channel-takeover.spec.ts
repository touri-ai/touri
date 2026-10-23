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
  await composer.fill("@Planejamento confira o portal de demonstração e continue depois do login.")
  await composer.press("Enter")

  await expect(messages.getByText("O portal de demonstração pediu login para continuar.")).toBeVisible()
  await page.getByRole("tab", { name: /^Bots,/ }).click()
  await page.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
  await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
  await expect(page.locator(".browser-activity-card")).toHaveCount(0)
  await expect(page.locator(".sidebar-needs-you")).toBeVisible()
  const requestCue = page.locator(".sidebar-needs-you")
  await expect(page.locator('[data-bot-entry="bot-mark"] .sidebar-attention-button')).toHaveCount(0)
  await expect(requestCue).toBeVisible()
  await saveScreenshot("channel-takeover-sidebar-before.png", true)
  await requestCue.click()
  const browserCard = page.locator(".browser-activity-card").first()
  await expect(browserCard).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(browserCard.getByRole("button", { name: "Assumir", exact: true })).toBeVisible()
  await expect(browserCard).toContainText("portal.example.test")
  await saveScreenshot("channel-takeover-browser-card-after.png")

  await browserCard.getByRole("button", { name: "Assumir", exact: true }).click()
  const control = page.getByRole("region", { name: "Controle remoto do navegador" })
  await expect(control).toContainText("Você está no controle · Planejamento está pausado")
  await expect(browserCard.getByRole("button", { name: "Devolver para Planejamento" })).toBeVisible()
  await saveScreenshot("channel-takeover-active.png")

  await browserCard.getByRole("button", { name: "Devolver para Planejamento" }).click()
  await expect(control).toHaveCount(0)
  await expect(page.locator(".browser-activity-card")).toHaveCount(1)
  await expect(messages.getByText("Retomado após a devolução do navegador", { exact: true })).toHaveCount(0)
  await expect(page.locator(".composer-browser-status")).toContainText("Planejamento está trabalhando · No navegador")
  await page.evaluate(() => (window as Window & { completeChannelResume?: () => void }).completeChannelResume?.())
  await expect(
    messages.getByText("O portal de demonstração está pronto para continuar.", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("Cancelado por você", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Falhou", { exact: true })).toHaveCount(0)
  await expect(page.locator(".browser-activity-card")).toHaveCount(1)
  await expect(browserCard).toContainText("Usou o navegador · 3 ações")
  await saveScreenshot("channel-takeover-resumed.png")
})

test("an expired channel handoff shows that the request did not finish", async ({ page }, info) => {
  await page.goto("/test/e2e/channel-takeover-harness.html")
  const composer = page.getByRole("textbox", { name: "Mensagem para Equipe de viagens" })
  await composer.fill("@Planejamento confira o portal de demonstração e me chame para entrar.")
  await composer.press("Enter")
  await expect(page.locator(".browser-activity-card")).toBeVisible()

  await page.evaluate(() => (window as Window & { expireChannelHandoff?: () => void }).expireChannelHandoff?.())

  await expect(page.getByText("Ninguém assumiu a tempo. Peça de novo quando puder.", { exact: true })).toBeVisible()
  await expect(page.locator(".browser-run-state")).toHaveText("não concluído")
  const screenshot = await page.screenshot({ fullPage: true, animations: "disabled" })
  await writeFile(info.outputPath("channel-takeover-expired.png"), screenshot)
  const evidenceDirectory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!evidenceDirectory) return

  await mkdir(evidenceDirectory, { recursive: true })
  await writeFile(join(evidenceDirectory, "channel-takeover-expired.png"), screenshot)
})
