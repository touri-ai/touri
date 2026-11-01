import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { showBotRoutines, showWorkMode } from "./home-navigation"

test.use({ channel: "chromium", reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`message threads at ${width} in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/test/e2e/explicit-threads-harness.html?theme=${theme}`)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
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
      await expect(page.locator(".thread-context-header")).toContainText("Thread · Vamos planejar")
      await expect(page.getByRole("button", { name: "Voltar à conversa", exact: true })).toBeVisible()
      await expect(page.locator('[data-message-row="context-thread-demo-request"]')).toBeVisible()
      await expect(page.locator('[data-message-row="thread-demo-reply"]')).toHaveCount(0)
      await page.screenshot({ path: join(directory, `thread-anchored-${theme}-${width}.png`) })
      const composer = page.getByRole("textbox", { name: /Mensagem/ })
      await composer.fill("@mark Revise o cronograma nesta thread.")
      await composer.press("Enter")
      await expect(page.locator(".chat-message-list")).toContainText("o próximo passo está pronto")
      await page.getByRole("button", { name: "Voltar à conversa", exact: true }).click()
      await expect(page.getByRole("button", { name: "2 respostas", exact: true })).toBeVisible()
      await page.screenshot({ path: join(directory, `thread-counter-${theme}-${width}.png`) })
    })
  }
}

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`routine thread opt-in at ${width} in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/test/e2e/explicit-threads-harness.html?theme=${theme}`)
      const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
      if (await menu.isVisible()) await menu.click()
      await showBotRoutines(page)
      await page.getByRole("button", { name: "Ações da rotina Plano diário", exact: true }).click()
      await page.getByRole("menuitem", { name: "Editar", exact: true }).click()
      const editor = page.getByRole("dialog", { name: "Quando?" })
      const choice = editor.getByRole("checkbox", { name: "Nova thread a cada execução" })
      await expect(choice).not.toBeChecked()
      await choice.check()
      await expect(choice).toBeChecked()
      const directory = process.env.THREAD_EVIDENCE_DIR ?? testInfo.outputPath("evidence")
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: join(directory, `routine-explicit-${theme}-${width}.png`) })
      await editor.getByRole("button", { name: "Revisar rotina" }).click()
      await expect(page.getByRole("dialog", { name: "Revisar rotina", exact: true })).toContainText(
        "Nova thread a cada execução",
      )
    })
  }
}
