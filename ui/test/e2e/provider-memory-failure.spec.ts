import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a memory stop reads plainly in the notification center at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    await page.evaluate(() => {
      const fixture = window as Window & {
        groupsQa?: { api: { notify: (input: Record<string, unknown>) => unknown } }
      }
      fixture.groupsQa?.api.notify({
        kind: "turn-failed",
        botId: "bot-mark",
        threadId: "thread-mark",
        title: "Tarefas interrompidas",
        body: "Codex exited (137)",
      })
    })
    if (viewport.width < 500) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /^Notificações/ }).click()
    const center = page.getByRole("region", { name: "Central de notificações" })
    const row = center.getByTestId("notification-row").filter({ has: page.locator(".error-notice") })
    await expect(row).toHaveCount(1)
    // Captured before the copy assertions so the same spec records the old wording on main.
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/memory-stop-${viewport.width}.png` })
    await expect(row).toContainText(
      "O bot parou antes de terminar, talvez por falta de memória. Envie a mensagem de novo para continuar.",
    )
    await expect(row.locator(".error-notice > p").first()).not.toContainText(/137|provedor/)
    await row.getByRole("button", { name: "Detalhes do erro", exact: true }).click()
    await expect(row.getByText("Codex exited (137)", { exact: true })).toBeVisible()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/memory-details-${viewport.width}.png` })
  })
}
