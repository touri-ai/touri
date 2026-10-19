import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("automatic task threads no longer flood the sidebar and task mode groups them", async ({ page }) => {
  test.setTimeout(30_000)
  const screenshot = async (name: string) => {
    const directory = process.env.TOURI_SCREENSHOT_DIR
    if (directory) await page.screenshot({ path: `${directory}/${name}.png` })
  }
  const openConversations = async () => {
    const entry = page.locator('[data-bot-entry="bot-mark"]')
    const rows = entry.locator(".thread-row")
    if ((await rows.count()) === 0) await entry.locator(".bot-row-main").click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    return rows
  }

  await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-before")
  const before = await openConversations()
  await expect(before.filter({ hasText: "lead.reply" })).toHaveCount(12)
  await screenshot("automatic-conversations-before")

  await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-main")
  const main = await openConversations()
  await expect(main).toHaveCount(1)
  await expect(main.filter({ hasText: "lead.reply" })).toHaveCount(0)
  await screenshot("automatic-conversations-main")

  await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-grouped")
  const grouped = await openConversations()
  await expect(grouped.filter({ hasText: "Tarefas lead.reply · 12 hoje" })).toHaveCount(1)
  await expect(grouped.filter({ hasText: "lead.reply" })).toHaveCount(1)
  await screenshot("automatic-conversations-task-mode")
})
