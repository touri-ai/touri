import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } }, reducedMotion: "reduce" })

for (const viewport of [
  { name: "compact-desktop", width: 1024, height: 700 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`server browser takeover stays interactive and private: ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto("/test/e2e/browser-activity-harness.html?remote=true")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    const takeOverButton = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeOverButton).toBeVisible()
    expect(
      await takeOverButton.evaluate((button) => {
        const card = button.closest(".browser-activity-card")
        if (!card) return false
        const buttonBounds = button.getBoundingClientRect()
        const cardBounds = card.getBoundingClientRect()
        return buttonBounds.left >= cardBounds.left && buttonBounds.right <= cardBounds.right
      }),
    ).toBe(true)
    const captureDir = process.env.TOURI_BROWSER_CAPTURE_DIR
    const beforeScreenshot = captureDir
      ? join(captureDir, `browser-takeover-before-${viewport.name}.png`)
      : testInfo.outputPath(`browser-takeover-before-${viewport.name}.png`)
    await page.screenshot({ path: beforeScreenshot, fullPage: true })

    await page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }).click()
    await expect(page.getByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
    await expect(page.getByText(/Você está no controle · .* está pausado/)).toBeVisible()
    await expect(
      page.locator(".browser-takeover-screen img, .browser-takeover-screen canvas:visible").first(),
    ).toBeVisible()
    const afterScreenshot = captureDir
      ? join(captureDir, `browser-takeover-after-${viewport.name}.png`)
      : testInfo.outputPath(`browser-takeover-after-${viewport.name}.png`)
    await page.screenshot({ path: afterScreenshot, fullPage: true })

    const keyboard = page.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
    await expect(keyboard).toBeEnabled()
    const keyboardButton = page.getByRole("button", { name: "Digitar no navegador" })
    const keyboardButtonSize = await keyboardButton.boundingBox()
    if (!keyboardButtonSize) throw new Error("Missing browser keyboard control")
    expect(keyboardButtonSize.width).toBeGreaterThan(100)
    expect(keyboardButtonSize.height).toBeLessThan(65)
    await page.getByRole("button", { name: "Digitar no navegador" }).click()
    await expect(keyboard).toBeFocused()
    await page.keyboard.insertText("valor privado de teste")
    await expect
      .poll(() =>
        page.evaluate(() => {
          const browserActivityWindow = window as Window & {
            browserActivity?: { snapshot: () => { takeoverInputCount: number } }
          }
          return browserActivityWindow.browserActivity?.snapshot().takeoverInputCount
        }),
      )
      .toBe(1)
    await expect(keyboard).toHaveValue("")
    await expect(page.locator("body")).not.toContainText("valor privado de teste")

    await page
      .locator(".browser-activity-card")
      .getByRole("button", { name: /Devolver para mark/i })
      .click()
    await expect(
      page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }),
    ).toBeVisible()
  })
}
