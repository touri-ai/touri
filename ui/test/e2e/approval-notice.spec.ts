import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

for (const width of [1000, 760]) {
  test(`approval reminder leaves header controls clickable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(process.env.APPROVAL_NOTICE_URL ?? "/test/e2e/approval-notice-harness.html")
    const notice = page.locator(".approval-notice")
    await expect(page.getByText(/^Café Ideias pede sua aprovação:/)).toBeVisible()
    const screenshot = info.outputPath(`approval-reminder-${width}.png`)
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await info.attach(`approval reminder ${width}`, { path: screenshot, contentType: "image/png" })

    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText("Café Ideias")
    await expect(notice).toContainText("Permitir Leitura e escrita em …/phase-a para este bot.")
    await expect(notice).not.toContainText(/folder_access_request|requestedPath|previousMode|nextTurn|[{}]/)
    const panel = page.getByRole("button", { name: "Painel do bot", exact: true })
    const noticeBox = await notice.boundingBox()
    const panelBox = await panel.boundingBox()
    expect(noticeBox).not.toBeNull()
    expect(panelBox).not.toBeNull()
    if (!noticeBox || !panelBox) throw new Error("Missing header geometry")
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(panelBox.y)
    expect(
      await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      }),
    ).toBe(true)
    await panel.click()
    await expect(panel).toHaveAttribute("aria-expanded", "true")
    await notice.getByRole("button", { name: "Revisar", exact: true }).click()
    await expect(page.locator('[data-approval-id="folder-review"]')).toBeFocused()
    const reviewedScreenshot = info.outputPath(`approval-reviewed-${width}.png`)
    await page.screenshot({ path: reviewedScreenshot, animations: "disabled" })
    await info.attach(`approval reviewed ${width}`, { path: reviewedScreenshot, contentType: "image/png" })
    if (process.env.APPROVAL_NOTICE_CAPTURE)
      await page.screenshot({ path: `${process.env.APPROVAL_NOTICE_CAPTURE}/approval-notice-${width}.png` })
    await page.getByRole("button", { name: /Notificações/ }).click()
    const row = page.getByTestId("notification-row")
    await expect(row.locator(".notification-body")).not.toContainText(/[{}]|folder_access_request/)
    const details = row.locator(".ds-disclosure")
    await expect(details).toHaveAttribute("data-open", "false")
    await expect(details.locator("pre")).not.toBeVisible()
    await details.getByRole("button", { name: "Detalhes técnicos", exact: true }).click()
    await expect(details.locator("pre")).toBeVisible()
  })
}
