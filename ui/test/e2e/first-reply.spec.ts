import { expect, test } from "@playwright/test"

[1440, 390].forEach((width) => {
  ["dark", "light"].forEach((theme) => {
    test(`first reply replaces preparation before completion at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/test/e2e/chat-activity-harness.html?scene=streaming&theme=${theme}`)
      await expect(page.getByRole("status")).toHaveText("Preparando a resposta…")

      await page.evaluate("window.chatActivity.parts([{type:'text',text:'Olá!'}])")

      await expect(page.locator(".message-assistant")).toContainText("Olá!")
      const screenshot = process.env.TOURI_LATENCY_SCREENSHOT
      if (screenshot) await page.screenshot({ path: `${screenshot}-${width}-${theme}.png` })
      await expect(page.getByText("Preparando a resposta…")).toHaveCount(0)
      await expect(page.getByRole("status")).toHaveText("Trabalhando…")

      await page.evaluate("window.chatActivity.finish()")

      await expect(page.locator(".message-assistant")).toContainText("Olá!")
      await expect(page.locator(".activity-mark")).toHaveCount(0)
    })
  })
})
