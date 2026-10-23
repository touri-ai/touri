import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })

for (const width of [1440, 390]) {
  test(`integration messages show a distinct sender at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/integration-sender-harness.html")
    const message = page.locator('[data-message-id="notice"]')

    await expect(message.locator(".message-role")).toHaveText("touri avisos")
    await expect(message.getByText("Integração", { exact: true })).toBeVisible()
    await expect(message.locator('[data-bot-id="integration:notice"]')).toBeVisible()
    await expect(message).toHaveClass(/message-other-person/)
    await expect(message.getByText("Você", { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    const image = await page.screenshot({ animations: "disabled" })
    await writeFile(info.outputPath(`integration-${width}.png`), image)
    if (!process.env.TOURI_E2E_EVIDENCE_DIR) return

    await mkdir(process.env.TOURI_E2E_EVIDENCE_DIR, { recursive: true })
    await writeFile(join(process.env.TOURI_E2E_EVIDENCE_DIR, `integration-${width}.png`), image)
  })
}
