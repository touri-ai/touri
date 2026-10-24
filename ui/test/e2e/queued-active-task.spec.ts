import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const widths = [1440, 390]
widths.forEach((width) => {
  test(`a waiting request reaches its preceding task at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/work-harness.html?channel-queue")
    await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    await page.getByRole("button", { name: "Trabalho", exact: true }).click()
    const waiting = page.locator('[data-run-id="channel-waiting"]')
    const active = page.locator('[data-run-id="work-run-0"]')
    const destination = page.url()

    const control = waiting.getByRole("button", { name: "Ver tarefa anterior de Planejamento" })
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await control.click()

    await expect(active).toBeFocused()
    await expect(active).toBeInViewport()
    expect(page.url()).toBe(destination)
    expect(await active.evaluate((card) => getComputedStyle(card).outlineStyle)).toBe("solid")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      (await new AxeBuilder({ page }).include(".work-screen").withTags(["wcag2a", "wcag2aa"]).analyze()).violations,
    ).toEqual([])
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/preceding-task-${width}.png` })

    await active.getByRole("button", { name: "Parar só esta tarefa" }).click()

    await expect(active).toHaveCount(0)
    await expect(waiting).toHaveCount(0)
    await expect(page.locator('[data-run-id="channel-execution"]')).toBeVisible()
    await expect(page.getByRole("button", { name: /^Ver tarefa anterior de/ })).toHaveCount(0)
  })
})
