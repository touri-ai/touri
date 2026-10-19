import { expect, test } from "@playwright/test"

test.use({ channel: "chromium" })

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]

viewports.forEach((viewport) => {
  test(`bounded goal controls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await expect(page.locator(".goal-panel")).toHaveCount(0)

    await page.getByRole("button", { name: "Painel do bot" }).click()
    const botPanel = page.getByRole("complementary", { name: "Painel de mark" })
    const goalEntry = botPanel.getByRole("button", { name: "Definir objetivo", exact: true })
    await expect(goalEntry).toBeVisible()
    await goalEntry.click()
    await botPanel
      .getByRole("textbox", { name: "O que precisa estar pronto para concluir?" })
      .fill("Tabela com três opções, preços e fontes verificadas.")
    await botPanel.getByRole("button", { name: "Continuar até concluir", exact: true }).click()
    const confirmation = botPanel.getByRole("status")
    await expect(confirmation).toHaveText("Objetivo iniciado nesta conversa")
    await expect(confirmation).toBeFocused()
    await botPanel.getByRole("button", { name: "Fechar painel do bot" }).click()

    const panel = page.getByRole("region", { name: "Continuar até concluir" })
    await expect(panel.getByRole("status")).toHaveText("Em andamento")
    await expect(panel).toContainText("3 turnos seguintes")
    await panel.getByRole("button", { name: "Pausar", exact: true }).click()
    await expect(panel.getByRole("status")).toHaveText("Pausado")
    await panel.getByRole("button", { name: "Retomar", exact: true }).click()
    await expect(panel.getByRole("status")).toHaveText("Em andamento")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    await panel.getByRole("button", { name: "Concluir agora", exact: true }).click()
    await expect(panel).toHaveCount(0)

    await page.getByRole("button", { name: "Painel do bot" }).click()
    const reopenedBotPanel = page.getByRole("complementary", { name: "Painel de mark" })
    const newGoal = reopenedBotPanel.getByRole("button", { name: "Novo objetivo", exact: true })
    await expect(newGoal).toHaveAttribute("aria-expanded", "false")
    const directory = process.env.TOURI_GOAL_SHOTS_DIR
    if (directory) {
      await page.screenshot({
        path: `${directory}/completed-${viewport.width}.png`,
        mask: [page.locator(".composer-model")],
        animations: "disabled",
      })
    }

    await newGoal.click()
    await expect(newGoal).toHaveAttribute("aria-expanded", "true")
    const criterion = reopenedBotPanel.getByRole("textbox", { name: "O que precisa estar pronto para concluir?" })
    await expect(criterion).toBeFocused()
    await criterion.fill("Resumo revisado.")
    if (directory) {
      await page.screenshot({
        path: `${directory}/new-goal-${viewport.width}.png`,
        mask: [page.locator(".composer-model")],
        animations: "disabled",
      })
    }
    await reopenedBotPanel.getByRole("button", { name: "Continuar até concluir", exact: true }).click()

    const nextConfirmation = reopenedBotPanel.getByRole("status")
    await expect(nextConfirmation).toHaveText("Objetivo iniciado nesta conversa")
    await expect(nextConfirmation).toBeFocused()
    await expect(newGoal).toHaveCount(0)
    await reopenedBotPanel.getByRole("button", { name: "Fechar painel do bot" }).click()

    const nextGoal = page.getByRole("region", { name: "Continuar até concluir" })
    await expect(nextGoal.getByRole("status")).toHaveText("Em andamento")
    await expect(nextGoal).toContainText("Resumo revisado.")
  })
})
