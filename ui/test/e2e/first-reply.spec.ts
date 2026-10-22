import { expect, test } from "@playwright/test"

test("first reply replaces preparation before the turn completes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await page.goto("/test/e2e/chat-activity-harness.html?scene=streaming&theme=dark")
  await expect(page.getByRole("status")).toHaveText("Preparando a resposta…")

  await page.evaluate("window.chatActivity.parts([{type:'text',text:'Olá!'}])")

  await expect(page.locator(".message-assistant")).toContainText("Olá!")
  await expect(page.getByText("Preparando a resposta…")).toHaveCount(0)
  await expect(page.getByRole("status")).toHaveText("Escrevendo")
  await page.screenshot({ path: testInfo.outputPath("first-reply-streaming.png") })

  await page.evaluate("window.chatActivity.finish()")

  await expect(page.locator(".message-assistant")).toContainText("Olá!")
  await expect(page.locator(".activity-mark")).toHaveCount(0)
})
