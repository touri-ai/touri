import { expect, test } from "@playwright/test"

type RetentionWindow = { retentionWorkload: { round: () => void; historyRequests: number[] } }

test("workspace retention: 30 bots bound browser heap and reload evicted history", async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/workspace-retention-harness.html")
  await expect(page.locator('[data-message-id="retention-message-0-0"]')).toBeVisible()
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage")
    return (await cdp.send("Runtime.getHeapUsage")).usedSize as number
  }
  const baselineBytes = await heap()
  const samples: number[] = []
  for (let wave = 0; wave < 2; wave++) {
    await page.evaluate(async () => {
      const fixture = (window as unknown as RetentionWindow).retentionWorkload
      for (let round = 0; round < 20; round++) {
        fixture.round()
        await new Promise<void>((done) => setTimeout(done, 0))
      }
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    samples.push(await heap())
  }
  const budgetBytes = 8 * 1024 * 1024
  const measurements = { bots: 30, backgroundBots: 29, turnsPerBackgroundBot: 40, baselineBytes, samples, budgetBytes }
  console.log("Workspace retention heap:", JSON.stringify(measurements))
  await testInfo.attach("workspace-retention-budget.json", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  })
  for (const bytes of samples) expect(bytes - baselineBytes).toBeLessThan(budgetBytes)
  expect(
    await page.evaluate(() => (window as unknown as RetentionWindow).retentionWorkload.historyRequests.slice(1)),
  ).toEqual(Array.from({ length: 29 }, () => 0))

  await page.locator('[data-bot-entry="retention-bot-1"] .bot-row-main').click()
  await expect(page.locator('[data-message-id="retention-message-1-40"]')).toContainText("Generated reply 1.40.")
  await page.locator('[data-bot-entry="retention-bot-0"] .bot-row-main').click()
  await expect(page.locator('[data-message-id="retention-message-0-0"]')).toBeVisible()
  await page.locator('[data-bot-entry="retention-bot-1"] .bot-row-main').click()
  await expect(page.locator('[data-message-id="retention-message-1-40"]')).toContainText("Generated reply 1.40.")
  expect(await page.evaluate(() => (window as unknown as RetentionWindow).retentionWorkload.historyRequests[1])).toBe(2)
})
