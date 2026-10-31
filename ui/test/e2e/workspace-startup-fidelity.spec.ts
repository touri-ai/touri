import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

for (const width of [1440, 390]) {
  test(`workspace startup preserves the conversation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/bot-list-startup-harness.html")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await expect(page.locator("#sidebar-mode-panel-bots .bot-entry")).toHaveCount(3)
    await page.screenshot({ path: info.outputPath(`pending-${width}.png`), animations: "disabled" })

    await page.evaluate(() => {
      const evidence = Reflect.get(window, "startupEvidence") as { release: () => void }

      evidence.release()
    })
    if (width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()

    const composer = page.getByRole("textbox", { name: "Mensagem para mark" })
    await expect(composer).toBeVisible()
    await composer.fill("Mensagem de teste")
    await expect(composer).toHaveValue("Mensagem de teste")
    await expect(composer).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`ready-${width}.png`), animations: "disabled" })
  })
}
