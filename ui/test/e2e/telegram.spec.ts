import { expect, test } from "@playwright/test"

test("Telegram settings: a saved token is required before enabling on desktop and phone", async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/telegram-harness.html")
    const toggle = page.getByRole("checkbox", { name: "Ativar Telegram" })
    const token = page.getByLabel("Token do bot")
    const guidance = "Salve o token do bot para ativar o Telegram."
    await expect(toggle).toBeDisabled()
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toHaveAccessibleDescription(guidance)
    await expect(token).toHaveAccessibleDescription(guidance)
    await expect(page.getByRole("status")).toHaveText("Desligado")

    await token.fill("123456789:AAExampleTokenForTouriTests_123456")

    await expect(toggle).toBeDisabled()
    await page.getByRole("button", { name: "Salvar token" }).click()
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText(guidance)).toBeHidden()
    await expect(page.getByRole("status")).toHaveText("Desligado")

    await toggle.check()

    await expect(page.getByRole("status")).toHaveText("Conectado como @touri_mock_bot")
    await page.getByRole("button", { name: "Remover token" }).click()
    await expect(toggle).toBeDisabled()
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText(guidance)).toBeVisible()
    await expect(page.getByRole("status")).toHaveText("Desligado")
  }
})

test("Telegram settings: changing bots clears an unsaved token and recipient list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/test/e2e/telegram-harness.html")
  const token = page.getByLabel("Token do bot")
  await expect(page.getByRole("checkbox", { name: "Ativar Telegram" })).not.toBeChecked()
  await token.fill("123456789:AAExampleTokenForTouriTests_123456")
  await page.getByLabel("IDs de usuário permitidos").fill("42")
  await page.getByRole("combobox", { name: "Bot", exact: true }).selectOption("bot-b")
  const before = process.env.TELEGRAM_PHASE === "before"
  await expect(token).toHaveValue(before ? "123456789:AAExampleTokenForTouriTests_123456" : "")
  await expect(page.getByLabel("IDs de usuário permitidos")).toHaveValue("")
  const output = process.env.TELEGRAM_CAPTURE ?? "../docs/evidence/telegram"
  await page.screenshot({ path: `${output}/${before ? "before" : "after"}-bot-switch.png`, animations: "disabled" })
})
