import { expect, type Locator, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

// Fully on screen and on top: not scrolled away and not hidden under another layer.
const isUncovered = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return [box.top + 1, box.bottom - 1].every((y) => {
      const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
      return hit !== null && element.contains(hit)
    })
  })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`taking over a loaded page keeps the handback and privacy note in view at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/browser-outcome-harness.html?takeover=live")
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill("Rascunho que deve continuar aqui")
    const takeover = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeEnabled({ timeout: 20_000 })
    await takeover.click()

    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(view.getByRole("img")).toBeVisible({ timeout: 20_000 })
    const handback = view.getByRole("button", { name: "Devolver para mark", exact: true })
    const privacy = view.getByRole("status", { name: "Privacidade do navegador" })
    // Let the history settle as it does after the session starts; the test itself never scrolls.
    await page.waitForTimeout(400)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-live-${viewport.width}.png` })

    for (const element of [handback, privacy]) {
      await expect(element).toBeInViewport({ ratio: 1 })
      expect(await isUncovered(element)).toBe(true)
    }

    await handback.click()
    await expect(view).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as Window & { browserOutcome?: { releases: string[] } }).browserOutcome?.releases,
      ),
    ).toEqual(["browser-outcome-tab"])
    await expect(
      page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }),
    ).toBeVisible()
    await expect(input).toHaveValue("Rascunho que deve continuar aqui")
  })
}
