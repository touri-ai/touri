import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("pending login recovers after a failed read without focus and stops polling when ready", async ({ page }) => {
  const startedAt = Date.now()
  await page.clock.install({ time: startedAt })
  await page.clock.pauseAt(startedAt + 1000)
  await page.goto("/test/e2e/qa-r4-harness.html?scenario=login-recovery")
  // Resolve the optional interface before advancing its suspended render, short of the first one-second poll.
  await page.evaluate(async () => {
    const modulePath = "/src/components/ProviderLoginFlow.tsx"
    await import(modulePath)
  })
  await page.clock.runFor(500)
  const code = page.getByRole("textbox", { name: "Código de login" })
  await expect(code).toHaveValue("QA")
  expect(await page.evaluate("window.qaR4LoginReads()")).toBe(1)

  await page.clock.runFor(1000)
  expect(await page.evaluate("window.qaR4LoginReads()")).toBe(2)
  await expect(code).toHaveValue("QA")

  await page.clock.runFor(1000)
  expect(await page.evaluate("window.qaR4LoginReads()")).toBe(3)
  await expect(code).toHaveCount(0)

  await page.clock.runFor(5000)
  expect(await page.evaluate("window.qaR4LoginReads()")).toBe(3)
})
