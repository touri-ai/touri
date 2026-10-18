import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"

for (const theme of ["light", "dark"] as const) {
  test(`learning settings stay opt-in · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.addInitScript((value) => {
      localStorage.setItem("touri.appearance.v1", value)
      localStorage.removeItem("touri.workspace.v1")
    }, theme)
    await page.goto("/test/e2e/screens-harness.html", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await openGlobalPage(page, "Integrações")
    const card = page.locator(".learning-card")
    const memory = card.getByRole("switch", { name: /Memória automática/ })
    const skills = card.getByRole("switch", { name: /Skills automáticas/ })
    await expect(memory).not.toBeChecked()
    await expect(skills).not.toBeChecked()
    const bounds = await memory.boundingBox()
    expect(Math.min(bounds?.width ?? 0, bounds?.height ?? 0)).toBeGreaterThanOrEqual(24)

    await memory.click()
    await expect(memory).toBeChecked()
    await expect(skills).not.toBeChecked()
    await expect(card.getByText("Ativo", { exact: true })).toBeVisible()
    await expect(card.getByText(/respostas concluídas/)).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const evidence = resolve(import.meta.dirname, "../../../docs/qa/learning")
    await mkdir(evidence, { recursive: true })
    await card.screenshot({ path: resolve(evidence, `${theme}.png`), animations: "disabled" })
  })
}
