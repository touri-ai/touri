import { expect, type Page, test } from "@playwright/test"
import { openBotActions } from "./home-navigation"

test.use({ channel: "chromium", reducedMotion: "reduce", viewport: { width: 1280, height: 900 } })

test("bot deletion explains an active machine and allows retry", async ({ page }, testInfo) => {
  await page.goto("/test/e2e/bot-delete-error-harness.html")
  await openDeletion(page, "sidebar")
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

for (const locale of ["pt-BR", "en"] as const) {
  test(`sidebar deletion confirms background cleanup in ${locale}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
    await page.goto(`/test/e2e/bot-delete-error-harness.html?cleanup=accepted&lang=${locale}`)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await openDeletion(page, "sidebar")
    const dialog = page.getByRole("dialog", { name: "Excluir bot", exact: true })
    await dialog.getByLabel("Digite o nome do bot: mark").fill("mark")
    const inputBounds = await dialog.getByLabel("Digite o nome do bot: mark").boundingBox()
    const dialogBounds = await dialog.boundingBox()
    if (!inputBounds || !dialogBounds) throw new Error("Deletion confirmation is not visible")
    const confirmationTop = inputBounds.y - 24
    await page.screenshot({
      path: testInfo.outputPath(`bot-delete-before-${locale}.png`),
      animations: "disabled",
      clip: {
        x: dialogBounds.x,
        y: confirmationTop,
        width: dialogBounds.width,
        height: dialogBounds.y + dialogBounds.height - confirmationTop,
      },
    })

    await dialog.getByRole("button", { name: "Excluir bot", exact: true }).click()

    await expect(page.locator('[data-bot-entry="bot-mark"]')).toHaveCount(0)
    await expect(page.locator('[data-bot-entry="bot-onb"]')).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    const message =
      locale === "en"
        ? "The bot was removed. History and attachment cleanup continues in the background."
        : "O bot foi removido. A limpeza do histórico e dos anexos continua em segundo plano."
    const notice = page.getByRole("status").filter({ hasText: message })
    await expect(notice).toBeVisible()
    await expect(notice).toHaveClass(/notice-info/)
    await notice.screenshot({ path: testInfo.outputPath(`bot-delete-after-${locale}.png`), animations: "disabled" })
    if (locale === "pt-BR")
      await notice.screenshot({
        path: testInfo.outputPath("bot-delete-background-cleanup.png"),
        animations: "disabled",
      })
  })
}

for (const locale of ["pt-BR", "en"] as const) {
  for (const entry of ["sidebar", "settings"] as const) {
    test(`${entry} deletion keeps the ${locale} cleanup notice after the bot is gone`, async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
      await page.goto(`/test/e2e/bot-delete-error-harness.html?cleanup=pending&lang=${locale}`)
      await openDeletion(page, entry)
      const dialog = page.getByRole("dialog", { name: "Excluir bot", exact: true })
      await dialog.getByLabel("Digite o nome do bot: mark").fill("mark")

      await dialog.getByRole("button", { name: "Excluir bot", exact: true }).click()

      await expect(page.locator('[data-bot-entry="bot-mark"]')).toHaveCount(0)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.locator('[data-bot-entry="bot-onb"]')).toBeVisible()
      await page.evaluate(() => {
        const qaWindow = window as Window & { botDeletionQa: { finishCleanup: () => void } }
        qaWindow.botDeletionQa.finishCleanup()
      })

      const message =
        locale === "en"
          ? "The bot was deleted, but private attachment cleanup is pending. touri will automatically try to finish the cleanup."
          : "O bot foi excluído, mas a limpeza dos anexos privados está pendente. O touri tentará concluir a limpeza automaticamente."
      const notice = page.getByRole("status").filter({ hasText: message })
      await expect(notice).toBeVisible()
      await expect(notice).toHaveClass(/notice-info/)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.locator("body")).not.toContainText("private cleanup diagnostic")
      await notice.screenshot({
        path: testInfo.outputPath(`bot-delete-cleanup-pending-${entry}-${locale}.png`),
        animations: "disabled",
      })

      await notice.getByRole("button", { name: "Dispensar aviso" }).click()

      await expect(notice).toHaveCount(0)
    })
  }
}

const openDeletion = async (page: Page, entry: "sidebar" | "settings"): Promise<void> => {
  await openBotActions(page, "mark")
  if (entry === "sidebar") {
    await page.getByRole("menuitem", { name: "Excluir bot" }).click()
    return
  }

  await page.getByRole("menuitem", { name: "Avançado", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Avançado/ })
    .click()
  await page.getByRole("button", { name: "Excluir bot", exact: true }).click()
}
