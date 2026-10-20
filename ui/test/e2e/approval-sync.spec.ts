import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  test(`an approval resolved elsewhere clears the banner and chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/approval-notice-harness.html")
    await expect(page.locator(".approval-notice")).toContainText("pede sua aprovação:")
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { approvalNoticeFixture: { echo: () => void; resolve: () => Promise<unknown> } }
      ).approvalNoticeFixture
      fixture.echo()
      return fixture.resolve()
    })
    await expect(page.locator(".approval-notice")).toHaveText("Autorizado. Retomando a tarefa.", { timeout: 500 })
    await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0)
    await expect(page.locator(".notice-bar:not(.approval-notice)")).toHaveCount(0)
    await expect(page.locator(".approval-notice")).toHaveCount(0, { timeout: 4500 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("web notification preferences explain closed-app delivery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/approval-notice-harness.html")
  await expect(page.locator(".approval-notice")).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event("touri-report-problem")))
  await page.getByRole("tab", { name: "Notificações", exact: true }).click()
  await expect(
    page.getByText("Com o touri fechado, você não recebe avisos. Ao abrir, as solicitações pendentes aparecem."),
  ).toBeVisible()
})

for (const source of ["chat", "bell"]) {
  test(`approval from the ${source} immediately clears the other surfaces`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/test/e2e/approval-notice-harness.html")
    await expect(page.locator(".approval-notice")).toBeVisible()
    if (source === "bell") {
      await page.getByRole("button", { name: /Notificações/ }).click()
      await page.getByTestId("notification-row").getByRole("button", { name: "Aprovar", exact: true }).click()
    } else await page.getByRole("button", { name: "Aprovar", exact: true }).click()
    await expect(page.locator(".approval-notice")).toHaveText("Autorizado. Retomando a tarefa.", { timeout: 500 })
    await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toHaveCount(0)
    await expect(page.locator(".notice-bar:not(.approval-notice)")).toHaveCount(0)
  })
}
