import { expect, type Locator } from "@playwright/test"
import { test } from "./production-fixture"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const unavailable = "Esta sessão do navegador está indisponível."

// Visible and on top: not scrolled away and not hidden under a sticky header.
const isUncovered = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    // Both the first and the last pixel rows must belong to the element, not to a header above it.
    return [box.top + 1, box.bottom - 1].every((y) => {
      const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
      return hit !== null && element.contains(hit)
    })
  })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`taking over from the composer shows its outcome in view at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/browser-outcome-harness.html")
    const strip = page.locator(".composer-browser-takeover")
    await expect(strip).toBeVisible({ timeout: 20_000 })
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await input.fill("Rascunho que deve continuar aqui")

    await strip.click()
    const outcome = page.getByRole("alert").filter({ hasText: unavailable })
    await expect(outcome).toHaveCount(1)
    const handback = page.locator(".browser-activity-recovery-return")
    for (const element of [outcome, handback]) {
      await expect(element).toBeInViewport({ ratio: 1 })
      await expect.poll(() => isUncovered(element)).toBe(true)
    }
    await expect(page.getByText(/Você está no controle/)).toHaveCount(0)

    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/composer-takeover-${viewport.width}.png` })

    await handback.click()
    await expect(outcome).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as Window & { browserOutcome?: { handbacks: string[] } }).browserOutcome?.handbacks,
      ),
    ).toEqual(["browser-outcome-tab"])
    await expect(input).toHaveValue("Rascunho que deve continuar aqui")
  })
}
