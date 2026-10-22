import { expect, test } from "@playwright/test"
import { chooseBotAction } from "./home-navigation"

test("new conversation: preserves a draft while creation is pending", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 850 })
  await page.goto("/test/e2e/new-conversation-harness.html")
  await page.getByRole("textbox", { name: "Mensagem para mark" }).waitFor()
  await chooseBotAction(page, "Nova conversa")
  await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Revise este novo assunto")
  const before = process.env.CONVERSATION_PHASE === "before"
  const output = process.env.CONVERSATION_CAPTURE ?? "../docs/qa/new-conversation"
  await page.screenshot({ animations: "disabled", path: `${output}/${before ? "before" : "after"}-pending.png` })
  if (!before) await expect(page.getByRole("button", { name: "Enviar" })).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as { conversationEvidence: { release: () => void } }).conversationEvidence.release(),
  )
  await expect(page.getByRole("button", { name: "Enviar" }))
    .toBeEnabled({ timeout: before ? 100 : 5000 })
    .catch((error) => {
      if (!before) throw error
    })
  if (before) await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("")
  await page.screenshot({ animations: "disabled", path: `${output}/${before ? "before" : "after"}-ready.png` })
  if (!before) {
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("Revise este novo assunto")
    await page.getByRole("button", { name: "Enviar" }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("")
  }
})
