import { expect, test } from "@playwright/test"

const capture = process.env.MODEL_CAPACITY_CAPTURE
const widths = [1440, 390]

widths.forEach((width) => {
  test(`model capacity recovery suggests switching models at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })

    await page.goto("/test/e2e/error-contract-harness.html?scenario=capacity")

    const card = page.locator(".message-error").first()
    await expect(card).toBeVisible()
    await expect(card).toContainText("O modelo selecionado está sem capacidade no momento.")
    await expect(card).toContainText(
      "Escolha outro modelo nas configurações do bot ou tente de novo em alguns minutos.",
    )
    await expect(card).not.toContainText(/atingiu o limite de uso|Muitas solicitações/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    if (capture) await card.screenshot({ path: `${capture}/model-capacity-${width}.png` })
  })
})
