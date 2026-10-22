import { expect, test } from "@playwright/test"

test("bot list startup: secondary requests do not block the list", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 850 })
  await page.goto("/test/e2e/bot-list-startup-harness.html")
  const before = process.env.STARTUP_PHASE === "before"
  const output = process.env.STARTUP_CAPTURE ?? "../docs/qa/bot-list-startup"
  if (before) await expect(page.getByText("Preparando o espaço de trabalho…")).toBeVisible()
  else await expect(page.locator("#sidebar-mode-panel-bots .bot-entry")).toHaveCount(3)
  await page.screenshot({ animations: "disabled", path: `${output}/${before ? "before" : "after"}-pending.png` })
  await page.evaluate(() =>
    (window as unknown as { startupEvidence: { release: () => void } }).startupEvidence.release(),
  )
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
})
