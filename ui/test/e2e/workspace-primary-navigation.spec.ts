import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

for (const width of [1440, 390]) {
  test(`channel navigation needs no module request after the shell at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/bot-list-startup-harness.html?channels=1")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await expect(page.locator("#sidebar-mode-panel-bots .bot-entry")).toHaveCount(3)
    // This bounded request observer measures the extra navigation dependency after the shell exists.
    const moduleRequests = new Set<string>()
    page.on("request", (request) => {
      if (/\/components\/(?:Groups|GroupSidebar)\.tsx(?:\?|$)/.test(request.url()))
        moduleRequests.add(new URL(request.url()).pathname)
    })

    const started = await page.evaluate(() => {
      const evidence = Reflect.get(window, "startupEvidence") as { release: () => void }
      const started = performance.now()

      evidence.release()
      return started
    })
    await expect(page.getByRole("heading", { name: "Canais", exact: true })).toBeVisible()
    const elapsedMs = await page.evaluate((started) => performance.now() - started, started)
    await page.screenshot({ path: info.outputPath(`channels-${width}.png`), animations: "disabled" })

    console.info(JSON.stringify({ width, elapsedMs, moduleRequests: Array.from(moduleRequests) }))
    expect(Array.from(moduleRequests)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
