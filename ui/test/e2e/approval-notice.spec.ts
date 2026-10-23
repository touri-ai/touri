import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

for (const width of [1000, 760]) {
  test(`central approval reminder leaves header controls clickable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(process.env.APPROVAL_NOTICE_URL ?? "/test/e2e/approval-notice-harness.html")
    const notice = page.locator(".approval-notice")
    const pending = page.locator(".sidebar-needs-you")
    await expect(notice).toBeHidden()
    await expect(pending).toBeVisible()
    await expect(pending).toContainText("Café Ideias")
    await expect(pending).not.toContainText(/folder_access_request|requestedPath|previousMode|nextTurn|[{}]/)
    const panel = page.getByRole("button", { name: "Painel do bot", exact: true })
    await panel.click({ trial: true })
    await panel.click()
    await expect(panel).toHaveAttribute("aria-expanded", "true")
    await panel.click()
    await expect(panel).toHaveAttribute("aria-expanded", "false")

    await pending.click()

    const card = page.locator('[data-approval-id="folder-review"]')
    await expect(card).toBeFocused()
    await expect(card).toContainText("Leitura e escrita")
    await card.getByRole("button", { name: /^(Mais opções de aprovação|Detalhes técnicos)$/ }).click()
    await expect(card.locator(".tool-technical")).toHaveAttribute("data-open", "true")
    const screenshot = info.outputPath(`approval-reviewed-${width}.png`)
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await info.attach(`approval reviewed ${width}`, { path: screenshot, contentType: "image/png" })
    await page.getByRole("button", { name: /Notificações/ }).click()
    const row = page.getByTestId("notification-row")
    await expect(row.locator(".notification-body")).not.toContainText(/[{}]|folder_access_request/)
    await expect(row.getByRole("button", { name: "Abrir e revisar", exact: true })).toBeVisible()
    await expect(row.locator(".notification-technical")).toHaveCount(0)
  })
}
