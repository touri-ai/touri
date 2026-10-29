import { expect, test } from "@playwright/test"

const capture = process.env.MODEL_CAPACITY_CAPTURE
const scenarios = [1440, 390].flatMap((width) => [false, true].map((recordedActions) => ({ width, recordedActions })))

scenarios.forEach(({ width, recordedActions }) => {
  test(`model capacity recovery suggests switching models at ${width}px, actions: ${recordedActions}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })

    await page.goto(
      `/test/e2e/error-contract-harness.html?scenario=capacity&actions=${recordedActions ? "recorded" : "none"}`,
    )

    const card = page.locator(".message-error").first()
    await expect(card).toBeVisible()
    await expect(card).toContainText("O modelo selecionado está sem capacidade no momento.")
    await expect(card).toContainText(
      "Escolha outro modelo nas configurações do bot ou tente de novo em alguns minutos.",
    )
    await expect(card).not.toContainText(/atingiu o limite de uso|Muitas solicitações/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    if (recordedActions) {
      await expect(card).toContainText("Algumas ações podem ter sido concluídas.")
      await expect(card.getByRole("button", { name: "Tentar novamente", exact: true })).toHaveCount(0)
      await card.getByRole("button", { name: "Ver ações realizadas" }).click()
      await expect(card.getByRole("region", { name: "Ações registradas" })).toBeVisible()
      await card.getByRole("button", { name: "Retomar tarefa" }).click()
      await expect(page.getByRole("textbox", { name: /^Mensagem para/ })).not.toHaveValue("")
    }

    if (capture) await card.screenshot({ path: `${capture}/model-capacity-${width}-${recordedActions}.png` })
  })
})
