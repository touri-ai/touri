import { copyFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]

for (const viewport of viewports) {
  test(`routine search dates: ${viewport.name}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-search-harness.html")
    await expect(page.getByRole("button", { name: /Planejamento/ }).first()).toBeVisible()
    await page.keyboard.press("Control+k")
    const input = page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })
    await expect(input).toBeFocused()
    const option = page.locator('[data-palette-item="thread:qa-routine-thread"]')
    await expect(option).toBeVisible()
    // Let the newly mounted overlay paint before collecting visual evidence.
    await page.evaluate(async () => {
      const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve))
      await frame()
      await frame()
    })
    const screenshot = info.outputPath(`routine-search-${viewport.name}.png`)
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await info.attach(`routine search ${viewport.name}`, { path: screenshot, contentType: "image/png" })
    const evidenceDirectory = process.env.TOURI_SCREENSHOT_DIR
    if (evidenceDirectory) await copyFile(screenshot, join(evidenceDirectory, `after-${viewport.name}.png`))

    await expect(option).toContainText("Checagem de QA no canal · 23/10/2026, 02:00")
    await input.fill("10/23/26")

    await expect(option).toContainText("Checagem de QA no canal · 23/10/2026, 02:00")
    await input.fill("23/10/2026")

    await expect(option).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toHaveJSProperty(
      "scrollWidth",
      await page.getByRole("dialog", { name: "Paleta de comandos" }).evaluate((element) => element.clientWidth),
    )
  })
}
