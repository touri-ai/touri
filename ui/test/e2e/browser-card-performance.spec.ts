import { expect, test } from "@playwright/test"

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`browser card updates preserve the frame budget at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/browser-activity-harness.html?theme=light")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    await expect(page.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })

    const metrics = await page.getByLabel("Cabine").evaluate(async (select) => {
      // Bounded local samples measure render completion without driver round trips.
      const samples: number[] = []
      const longTasks: number[] = []
      const shifts: number[] = []
      const surroundingShifts: number[] = []
      const tasks = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration))
      })
      const layout = new PerformanceObserver((list) => {
        const entries = list.getEntries() as Array<
          PerformanceEntry & {
            value: number
            sources: Array<{ node: Node | null }>
          }
        >
        // Rolling rows move inside a fixed log viewport; guard the surrounding card layout separately.
        const surrounding = entries.filter(
          (entry) =>
            !entry.sources.length ||
            entry.sources.some(({ node }) => !node?.parentElement?.closest(".browser-activity-log")),
        )
        shifts.push(...entries.map((entry) => entry.value))
        surroundingShifts.push(...surrounding.map((entry) => entry.value))
      })
      tasks.observe({ type: "longtask" })
      layout.observe({ type: "layout-shift" })
      for (const _ of Array.from({ length: 24 })) {
        const started = performance.now()
        select.dispatchEvent(new Event("change", { bubbles: true }))
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        samples.push(performance.now() - started)
      }
      tasks.disconnect()
      layout.disconnect()
      const sorted = samples.toSorted((left, right) => left - right)

      return {
        samples: samples.length,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        longTasks: longTasks.length,
        maxLongTaskMs: Math.max(0, ...longTasks),
        layoutShift: shifts.reduce((sum, value) => sum + value, 0),
        surroundingLayoutShift: surroundingShifts.reduce((sum, value) => sum + value, 0),
      }
    })

    console.info("browser card render metrics", JSON.stringify({ width: viewport.width, ...metrics }))
    expect(metrics.p95Ms).toBeLessThan(100)
    expect(metrics.maxLongTaskMs).toBeLessThan(50)
    expect(metrics.surroundingLayoutShift).toBeLessThan(0.001)
  })
}
