import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`member Stop preserves the waiting channel request at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/work-harness.html?channel-queue")
    await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
    const openWork = async () => {
      if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
      await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
      await page.getByRole("button", { name: "Trabalho", exact: true }).click()
    }
    await openWork()
    await page
      .locator('[data-run-id="channel-waiting"]')
      .getByRole("button", { name: "Equipe de demonstração", exact: true })
      .click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Equipe de demonstração" })).toBeVisible()

    await page.getByRole("button", { name: "Ações do time" }).click()
    const stop = page.getByRole("menuitem", { name: "Parar Planejamento", exact: true })
    await expect(stop).toBeVisible()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/member-stop-${viewport.width}.png` })
    await stop.click()
    await openWork()

    await expect(page.locator('[data-run-id="channel-execution"]')).toBeVisible()
    await expect(page.locator('[data-run-id="channel-waiting"]')).toHaveCount(0)
    await expect(page.locator('[data-run-id="work-run-0"]')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/member-follow-up-${viewport.width}.png` })
  })
}
