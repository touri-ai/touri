import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { showWorkMode } from "./home-navigation"

test.use({ channel: "chromium", reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`message threads at ${width} in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/test/e2e/explicit-threads-harness.html?theme=${theme}`)
      await showWorkMode(page)
      await page.getByRole("button", { name: /^Planejamento(?:,|$)/ }).click()
      const message = page.locator('[data-message-row="thread-demo-request"]')
      const reply = page.locator('[data-message-row="thread-demo-reply"]')
      await expect(message).toContainText("Vamos planejar")
      await expect(reply).toContainText("Podemos organizar")
      const directory = process.env.THREAD_EVIDENCE_DIR ?? testInfo.outputPath("evidence")
      await mkdir(directory, { recursive: true })
      await message.hover()
      await expect(message.getByRole("button", { name: "Iniciar thread" })).toBeVisible()
      await expect(reply.getByRole("button", { name: "Iniciar thread" })).toBeAttached()
      await page.screenshot({ path: join(directory, `thread-hover-${theme}-${width}.png`) })
      await message.getByRole("button", { name: "Iniciar thread" }).click()
      await expect(page.locator(".chat-message-list")).toContainText("Vamos planejar o lançamento")
      await expect(page.locator('[data-message-row="context-thread-demo-request"]')).toBeVisible()
      await page.screenshot({ path: join(directory, `thread-anchored-${theme}-${width}.png`) })
      const composer = page.getByRole("textbox", { name: /Mensagem/ })
      await composer.fill("@mark Revise o cronograma nesta thread.")
      await composer.press("Enter")
      await expect(page.locator(".chat-message-list")).toContainText("o próximo passo está pronto")
      await showWorkMode(page)
      await page.getByRole("button", { name: /^Planejamento(?:,|$)/ }).click()
      await expect(page.getByRole("button", { name: "2 respostas", exact: true })).toBeVisible()
      await page.screenshot({ path: join(directory, `thread-counter-${theme}-${width}.png`) })
    })
  }
}
