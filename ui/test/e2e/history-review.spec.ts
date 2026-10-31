import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR" })
test.setTimeout(60_000)

const scenarios = [1440, 390].flatMap((width) => (["dark", "light"] as const).map((theme) => ({ width, theme })))

scenarios.forEach(({ width, theme }) => {
  test(`history recovery is readable at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.goto("/test/e2e/history-notice-harness.html?open=failing")
    const notice = page.locator(".chat-panel .conversation-notice")
    await expect(notice).toContainText("O touri está reiniciando.")
    await expect(notice.getByText("TOURI-E1009", { exact: true })).toBeVisible()
    await expect(page.locator(".notice-bar")).toHaveCount(0)
    await expect(page.getByRole("status", { name: "Carregando conversas…" })).toHaveCount(0)

    const accessibility = await new AxeBuilder({ page }).include(".conversation-notice").analyze()
    expect(accessibility.violations).toEqual([])
    await saveEvidence(page, `after-history-${width}-${theme}`)
    await notice.getByRole("button", { name: "Detalhes", exact: true }).click()
    await expect(notice).toContainText("RUNTIME_DRAINING")
    await saveEvidence(page, `after-details-${width}-${theme}`)
    await page.evaluate(() => {
      window.historyFailing = false
    })
    await notice.getByRole("button", { name: "Tentar de novo", exact: true }).click()

    await expect(page.getByRole("region", { name: "Histórico da conversa" })).toContainText(
      "valide esse perfil e veja os posts",
    )
    await expect(notice).toHaveCount(0)
    await page.goto("/test/e2e/error-contract-harness.html?scenario=capacity")
    await expect(page.locator(".error-notice").first()).toBeVisible()
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await saveEvidence(page, `after-error-${width}-${theme}`)
  })
})

const saveEvidence = async (page: Page, name: string): Promise<void> => {
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name}.png`) })
}
