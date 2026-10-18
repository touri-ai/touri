import { expect, test } from "@playwright/test"

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
