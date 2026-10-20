import { expect, test } from "@playwright/test"

const baseline = process.env.ERROR_CONTRACT_BASELINE === "1"
const capture = process.env.ERROR_CONTRACT_CAPTURE
for (const width of [1440, 390]) {
  test(`error recovery is readable and operable at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/error-contract-harness.html")
    const card = page.locator(".message-error").first()
    await expect(card).toBeVisible()
    await expect(page.locator(".notice-bar.notice-error")).toHaveCount(0)
    await expect(page.locator(".composer-notice")).toBeVisible()
    await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toHaveCount(1)
    if (!baseline) {
      await expect(card).toContainText("Não consegui conectar à sua IA. Sua mensagem está salva.")
      await expect(card.getByRole("button", { name: "Tentar novamente" })).toBeVisible()
      await expect(card.locator("code")).not.toBeVisible()
      await expect(page.locator("body")).not.toContainText("{horario}")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    if (capture)
      await page.screenshot({
        path: `${capture}/${baseline ? "before" : "after"}-${width === 390 ? "mobile" : "desktop"}.png`,
      })
    if (width === 390) return
    await page.getByRole("button", { name: /Notificações/ }).click()
    const row = page.getByTestId("notification-row")
    await expect(row).toBeVisible()
    if (!baseline) {
      await expect(row).toContainText("Não consegui conectar à sua IA.")
      await expect(row.locator("code")).not.toBeVisible()
    }
    if (capture) await page.screenshot({ path: `${capture}/${baseline ? "before" : "after"}-notifications.png` })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await page.getByRole("tab", { name: "Computador", exact: true }).click()
    await expect(page.locator(".bot-computer")).toBeVisible()
    if (!baseline) {
      await expect(page.locator(".bot-computer [role=alert]")).toContainText("Não consegui conectar à sua IA.")
      await expect(page.locator(".bot-computer code")).not.toBeVisible()
    }
    if (capture) await page.screenshot({ path: `${capture}/${baseline ? "before" : "after"}-computer.png` })
    if (!baseline) {
      await card.getByText("Detalhes do erro").click()
      await expect(card.locator("code")).toBeVisible()
      if (capture) await page.screenshot({ path: `${capture}/after-expanded-details.png` })
    }
  })
}

const themes = ["light", "dark"] as const
const scenarios = ["network", "boot"] as const
const widths = [1440, 390] as const

themes.forEach((theme) => {
  scenarios.forEach((scenario) => {
    widths.forEach((width) => {
      test(`one recovery action: ${scenario}, ${theme}, ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)

        await page.goto(`/test/e2e/error-contract-harness.html?scenario=${scenario}`)

        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await expect(page.locator(".composer-notice")).toBeVisible()
        const retry = page.getByRole("button", { name: "Tentar novamente", exact: true })
        await expect(retry).toHaveCount(1)
        await expect(retry).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.locator(".chat-panel").screenshot({
          path: info.outputPath(`recovery-${scenario}-${theme}-${width}.png`),
          mask: [page.locator(".composer-model")],
        })
        await retry.click()
        await expect(page.locator(".composer textarea")).toBeVisible()
      })
    })
  })
})
