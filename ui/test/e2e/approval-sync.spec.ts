import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  test(`a confirmation replaces the pending count while another request remains at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/approval-notice-harness.html?pending-question")
    const notice = page.locator(".approval-notice")
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText("pede sua aprovação:")
    const getScreenshotPath = (state: string) =>
      process.env.APPROVAL_NOTICE_CAPTURE
        ? `${process.env.APPROVAL_NOTICE_CAPTURE}/${state}-${width}.png`
        : info.outputPath(`${state}-${width}.png`)
    await page.screenshot({ path: getScreenshotPath("pending"), animations: "disabled" })

    await page.evaluate(() => {
      const fixture = Reflect.get(window, "approvalNoticeFixture") as { resolve: () => Promise<unknown> }
      return fixture.resolve()
    })

    await expect(notice.filter({ hasText: "Autorizado. Retomando a tarefa." })).toBeVisible()
    await page.screenshot({ path: getScreenshotPath("confirmed"), animations: "disabled" })
    await expect(notice).toHaveCount(1, { timeout: 500 })
    await expect(notice).toHaveText("Você tem 1 solicitação pendente.", { timeout: 4500 })
    await page.screenshot({ path: getScreenshotPath("remaining"), animations: "disabled" })
    await notice.getByRole("button", { name: "Dispensar aviso" }).click()
    await expect(notice).toHaveCount(0)
  })

  test(`an approval resolved elsewhere clears the banner and chat at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/approval-notice-harness.html")
    const notice = page.locator(".approval-notice")
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText("pede sua aprovação:")
    const pendingScreenshot = info.outputPath(`approval-pending-${width}.png`)
    await page.screenshot({ path: pendingScreenshot, animations: "disabled" })
    if (width === 1440) await info.attach("approval pending", { path: pendingScreenshot, contentType: "image/png" })
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { approvalNoticeFixture: { echo: () => void; resolve: () => Promise<unknown> } }
      ).approvalNoticeFixture
      fixture.echo()
      return fixture.resolve()
    })
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveText("Autorizado. Retomando a tarefa.", { timeout: 500 })
    const resolvedScreenshot = info.outputPath(`approval-resolved-${width}.png`)
    await page.screenshot({ path: resolvedScreenshot, animations: "disabled" })
    if (width === 1440) await info.attach("approval resolved", { path: resolvedScreenshot, contentType: "image/png" })
    await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0)
    await expect(page.locator(".notice-bar:not(.approval-notice)")).toHaveCount(0)
    await expect(notice).toHaveCount(0, { timeout: 4500 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test("web notification preferences explain closed-app delivery", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/approval-notice-harness.html")
  await expect(page.locator(".approval-notice")).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event("touri-report-problem")))
  await page.getByRole("tab", { name: "Notificações", exact: true }).click()
  await expect(page.getByText(/Ative avisos neste aparelho para receber novidades/)).toBeVisible()
})

for (const source of ["chat"]) {
  test(`approval from the ${source} immediately clears the other surfaces`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/test/e2e/approval-notice-harness.html")
    const notice = page.locator(".approval-notice")
    await expect(notice).toHaveCount(1)
    await expect(notice).toBeVisible()
    await notice.getByRole("button", { name: "Revisar", exact: true }).click()
    await expect(page.locator('[data-approval-id="folder-review"]')).toBeFocused()
    await page.getByRole("button", { name: "Aprovar", exact: true }).click()
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveText("Autorizado. Retomando a tarefa.", { timeout: 500 })
    await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toHaveCount(0)
    await expect(page.locator(".notice-bar:not(.approval-notice)")).toHaveCount(0)
  })
}
