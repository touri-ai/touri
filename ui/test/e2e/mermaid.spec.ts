import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const phase = process.env.CHAT_TRANSCRIPT_PHASE ?? "after"
test.use({ channel: "chromium" })

for (const theme of ["light", "dark"]) {
  test(`mermaid ${phase} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 1000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(`/test/e2e/mermaid-harness.html?theme=${theme}`)
    await expect(page.getByText("A resposta está pronta.", { exact: false })).toBeVisible()
    if (phase === "after") await expect(page.locator(".mermaid-diagram svg")).toHaveCount(2)
    else await expect(page.locator(".markdown-code")).toHaveCount(2)
    await page.evaluate(() => document.fonts.ready)
    await mkdir("../docs/qa/chat-transcript", { recursive: true })
    await page.screenshot({ path: `../docs/qa/chat-transcript/mermaid-${phase}-${theme}.png`, fullPage: true })
  })
}
