import { expect, test } from "@playwright/test"

for (const width of [420, 720]) {
  test(`project picker stays inside a ${width}px window and unlinks by keyboard`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/r8-composer-harness.html")
    const composer = page.getByRole("form", { name: "Compor mensagem" })
    const chip = composer.getByRole("button", { name: /^Projeto do bot:/ })
    await expect(chip).toBeVisible()
    await chip.focus()
    await page.keyboard.press("Enter")
    const picker = page.locator(".composer-project-picker")
    await expect(picker).toBeVisible()
    const bounds = await picker.boundingBox()
    if (!bounds) throw new Error("Missing project picker bounds")
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    await expect(picker.getByRole("menuitemradio", { checked: true })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(picker.getByRole("menuitemradio", { name: "Somente pasta do bot" })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(chip).toHaveText(/Sem projeto/)
    await expect(picker).toBeHidden()
    await expect(chip).toBeFocused()
  })
}
