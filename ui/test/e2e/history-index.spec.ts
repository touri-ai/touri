import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ video: process.env.TOURI_E2E_EVIDENCE_DIR ? { mode: "on", size: { width: 1440, height: 900 } } : "off" })

for (const width of [1440, 390]) {
  test(`channel index recovery ${width} keeps saved messages inside the conversation`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/history-notice-harness.html?open=failing&index=1")
    const history = page.getByRole("region", { name: "Histórico da conversa" })
    await expect(history).toContainText("valide esse perfil e veja os posts")

    await page.evaluate(() => window.historyRefreshIndex?.(true))

    const notice = page.locator(".chat-panel .conversation-notice")
    await expect(notice).toContainText("O touri está reiniciando.")
    await expect(page.locator(".notice-bar")).toHaveCount(0)
    await expect(history).toContainText("valide esse perfil e veja os posts")
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (directory) {
      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: join(directory, `index-failure-${width}.png`) })
    }
    await page.evaluate(() => window.historyRefreshIndex?.(false))
    await notice.getByRole("button", { name: "Tentar de novo", exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect(history).toContainText("valide esse perfil e veja os posts")
    if (directory) {
      await page.screenshot({ path: join(directory, `index-recovered-${width}.png`) })
      const video = page.video()
      await page.close()
      if (video) await video.saveAs(join(directory, `index-recovery-${width}.webm`))
    }
    await info.attach("saved-history", {
      body: "Synthetic channel history retained during an index failure.",
      contentType: "text/plain",
    })
  })
}
