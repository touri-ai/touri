import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`notification preferences save on ${viewport.width}px web screens`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/home-harness.html")
    if (viewport.width < 500) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Você Local/ }).click()
    const dialog = page.getByRole("dialog", { name: "Configurações", exact: true })
    await dialog.getByRole("tab", { name: "Notificações", exact: true }).click()
    await dialog.getByText("Escolher avisos e horário silencioso", { exact: true }).click()

    await expect(dialog).toContainText("Com o touri fechado, você não recebe avisos.")
    await expect(dialog.getByRole("combobox", { name: "Aprovação", exact: true })).toHaveCount(0)
    await expect(dialog.getByRole("combobox", { name: "Pergunta", exact: true })).toHaveCount(0)
    await expect(dialog.getByRole("combobox", { name: "Precisa de você", exact: true })).toHaveCount(0)
    await dialog.getByLabel("Avisar sobre", { exact: true }).selectOption("all")
    await dialog.getByLabel("Aviso do bot", { exact: true }).selectOption("off")
    await dialog.getByLabel("Aplicar a", { exact: true }).selectOption("bot-mark")
    await dialog.getByLabel("Resposta falhou", { exact: true }).selectOption("off")
    await dialog.getByLabel("Ativar horário silencioso").check()
    await dialog.getByLabel("Das", { exact: true }).fill("23:00")
    await dialog.getByLabel("Até", { exact: true }).fill("07:00")
    await dialog.getByRole("button", { name: "Salvar preferências", exact: true }).click()

    if (viewport.width < 500) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Você Local/ }).click()
    await dialog.getByRole("tab", { name: "Notificações", exact: true }).click()
    await dialog.getByText("Escolher avisos e horário silencioso", { exact: true }).click()
    await expect(dialog.getByLabel("Avisar sobre", { exact: true })).toHaveValue("all")
    await expect(dialog.getByLabel("Aviso do bot", { exact: true })).toHaveValue("off")
    await dialog.getByLabel("Aplicar a", { exact: true }).selectOption("bot-mark")
    await expect(dialog.getByLabel("Resposta falhou", { exact: true })).toHaveValue("off")
    await expect(dialog.getByLabel("Das", { exact: true })).toHaveValue("23:00")
    await expect(dialog.getByLabel("Até", { exact: true })).toHaveValue("07:00")
    await dialog.getByText("Tipos de aviso", { exact: true }).scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: test.info().outputPath(`notification-preferences-${viewport.width}.png`) })
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })
}

test("a reopened page shows one actionable reminder and a plain no-news result", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/notification-preferences-harness.html")
  const reminder = page.locator(".approval-notice")
  await expect(reminder).toHaveCount(1)
  await expect(reminder).toContainText("mark pede sua aprovação:")
  await expect(reminder.getByRole("button", { name: "Revisar", exact: true })).toBeVisible()
  await expect(page.getByText("Você tem 2 solicitações pendentes.")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Notificações, 2 precisam de atenção", exact: true })).toBeVisible()

  await page.getByRole("button", { name: /^Notificações,/ }).click()

  const center = page.getByRole("region", { name: "Central de notificações" })
  await expect(center).toContainText("Qual projeto reviso primeiro?")
  await expect(center.getByRole("button", { name: "Aprovar", exact: true })).toBeVisible()
  await expect(center).toContainText("Rotina concluída sem novidades.")
  await expect(center).not.toContainText("NO_NOTIFICATION")
  await expect(center).not.toContainText("Texto bruto do modelo")
})
