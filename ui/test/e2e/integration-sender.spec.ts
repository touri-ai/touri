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
    await expect(message).toHaveAttribute("data-message-author", "bot")
    await expect(message).not.toHaveClass(/message-user/)
    await expect(message.locator('[aria-label="Membro excluído: touri avisos"]')).toHaveCount(0)
    const avatar = await message.locator(".message-avatar").boundingBox()
    const bubble = await message.locator(".message-body").boundingBox()
    expect(avatar).not.toBeNull()
    expect(bubble).not.toBeNull()
    if (avatar && bubble) expect(avatar.x + avatar.width).toBeLessThanOrEqual(bubble.x)
    await expect(message.getByText("Você", { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    const image = await page.screenshot({ animations: "disabled" })
    await writeFile(info.outputPath(`integration-${width}.png`), image)
    if (!process.env.TOURI_E2E_EVIDENCE_DIR) return

    await mkdir(process.env.TOURI_E2E_EVIDENCE_DIR, { recursive: true })
    await writeFile(join(process.env.TOURI_E2E_EVIDENCE_DIR, `integration-${width}.png`), image)
  })
}
