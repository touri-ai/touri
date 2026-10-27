import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

declare global {
  interface Window {
    retentionWorkload: { round: () => void; historyRequests: number[] }
  }
}

test("workspace retention: 30 bots bound browser heap and reload evicted history", async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/workspace-retention-harness.html")
  await expect(page.locator('[data-message-id="retention-message-0-0"]')).toBeVisible()
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage")
    return (await cdp.send("Runtime.getHeapUsage")).usedSize as number
  }
  const baselineBytes = await heap()
  // A fixed two-sample series stays local to this browser measurement.
  const samples: number[] = []
  const waves = []
  for (let wave = 0; wave < 2; wave++) {
    const metrics = await page.evaluate(async () => {
      const fixture = window.retentionWorkload
      // Samples and observers belong only to this bounded synthetic wave.
      const dispatchMs: number[] = []
      const longTasks: number[] = []
      const shifts: number[] = []
      const tasks = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration))
      })
      const layout = new PerformanceObserver((list) => {
        const entries = list.getEntries() as Array<PerformanceEntry & { value: number }>
        shifts.push(...entries.map((entry) => entry.value))
      })
      tasks.observe({ type: "longtask" })
      layout.observe({ type: "layout-shift" })
      for (let round = 0; round < 20; round++) {
        const started = performance.now()
        fixture.round()
        dispatchMs.push(performance.now() - started)
        await new Promise<void>((done) => setTimeout(done, 0))
      }
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      tasks.disconnect()
      layout.disconnect()
      const sorted = dispatchMs.toSorted((left, right) => left - right)

      return {
        dispatchP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        longTasksOver50Ms: longTasks.filter((duration) => duration > 50).length,
        maxLongTaskMs: Math.max(0, ...longTasks),
        cls: shifts.reduce((sum, value) => sum + value, 0),
      }
    })
    waves.push(metrics)
    samples.push(await heap())
  }
  const budgetBytes = 8 * 1024 * 1024
  const measurements = {
    bots: 30,
    backgroundBots: 29,
    turnsPerBackgroundBot: 40,
    baselineBytes,
    samples,
    budgetBytes,
    waves,
  }
  console.log("Workspace retention heap:", JSON.stringify(measurements))
  await testInfo.attach("workspace-retention-budget.json", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  })
  await writeFile(testInfo.outputPath("workspace-retention-budget.json"), JSON.stringify(measurements))
  for (const bytes of samples) expect(bytes - baselineBytes).toBeLessThan(budgetBytes)
  expect(await page.evaluate(() => window.retentionWorkload.historyRequests.slice(1))).toEqual(
    Array.from({ length: 29 }, () => 0),
  )

  await page.locator('[data-bot-entry="retention-bot-1"] .bot-row-main').click()
  await expect(page.locator('[data-message-id="retention-message-1-40"]')).toContainText("Generated reply 1.40.")
  await page.locator('[data-bot-entry="retention-bot-0"] .bot-row-main').click()
  await expect(page.locator('[data-message-id="retention-message-0-0"]')).toBeVisible()
  await page.locator('[data-bot-entry="retention-bot-1"] .bot-row-main').click()
  await expect(page.locator('[data-message-id="retention-message-1-40"]')).toContainText("Generated reply 1.40.")
  expect(await page.evaluate(() => window.retentionWorkload.historyRequests[1])).toBe(2)

  await page.screenshot({ path: testInfo.outputPath("workspace-retention-after-desktop.png"), animations: "disabled" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath("workspace-retention-after-phone.png"), animations: "disabled" })
})
