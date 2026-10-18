import { expect, test } from "@playwright/test"

test.use({ channel: "chromium" })

test("bot deletion explains an active machine and allows retry", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.goto("/test/e2e/bot-delete-error-harness.html")
  await page.getByLabel("Digite o nome do bot: mark").fill("mark")

  await page.getByRole("button", { name: "Excluir bot" }).click()

  await expect(page.getByRole("alert")).toHaveText(
    "O computador do bot ainda está em uso. Pare as tarefas e tente excluir novamente. [TOURI-E8004]",
  )
  await expect(page.getByRole("button", { name: "Excluir bot" })).toBeEnabled()
  await page
    .getByRole("alert")
    .screenshot({ path: testInfo.outputPath("bot-delete-blocker.png"), animations: "disabled" })
})
