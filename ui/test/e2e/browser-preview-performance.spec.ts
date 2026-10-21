import { expect, test } from "@playwright/test"

type BrowserActivitySnapshot = {
  previewRequests: number
  maxUiLongTaskMs: number
  longTaskObserverAvailable: boolean
}

type BrowserActivityWindow = Window & {
  browserActivity?: {
    resetPreviewMetrics: () => void
    snapshot: () => BrowserActivitySnapshot
  }
}

test("browser preview sampling keeps UI long tasks below 50 ms", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/test/e2e/browser-activity-harness.html?theme=dark")
  await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
  await expect(page.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()

  await page.evaluate(() => (window as BrowserActivityWindow).browserActivity?.resetPreviewMetrics())
  await expect
    .poll(
      () => page.evaluate(() => (window as BrowserActivityWindow).browserActivity?.snapshot().previewRequests ?? 0),
      {
        timeout: 10_000,
      },
    )
    .toBeGreaterThanOrEqual(2)

  const metrics = await page.evaluate(() => (window as BrowserActivityWindow).browserActivity?.snapshot())
  expect(metrics?.longTaskObserverAvailable).toBe(true)
  expect(metrics?.maxUiLongTaskMs ?? Number.POSITIVE_INFINITY).toBeLessThan(50)
})
