import { join } from "node:path"
import { expect, test } from "@playwright/test"

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`channel progress: one execution and global stop at ${viewport.width}`, async ({ page }, testInfo) => {
    // Cold module loading shares this deadline with the control and cancellation assertions.
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/group-progress-harness.html")
    const progress = page.locator(".activity-mark")
    const stops = page.getByRole("button", { name: "Parar", exact: true })
    const checks = page.getByRole("button", { name: "Verificar conexão", exact: true })

    await expect(progress).toHaveCount(1)
    await expect(stops).toHaveCount(1)
    await expect(checks).toHaveCount(1)
    await expect(progress.first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: join(
        process.env.TOURI_E2E_EVIDENCE_DIR ?? testInfo.outputDir,
        `after-channel-progress-${viewport.width}.png`,
      ),
    })

    await checks.click()
    await expect(page.getByText("A conexão com o touri está disponível. A IA pode continuar demorando.")).toBeVisible()
    await stops.click()

    await expect(page.locator("main")).toHaveAttribute("data-canceled-run", "progress-coordination")
    await expect(progress).toHaveCount(0)
    await expect(stops).toHaveCount(0)
    await expect(page.getByText("@mark Aguarde 60 segundos de verdade e depois responda.")).toBeVisible()
  })
}
