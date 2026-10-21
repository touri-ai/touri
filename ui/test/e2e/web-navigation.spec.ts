import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
const entry = "/test/e2e/r8-sidebar-harness.html"
const expectLocation = async (page: Page, bot: string, thread: string) => {
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("bot") === bot && url.searchParams.get("thread") === thread,
  )
  await expect(page.locator(`.bot-entry[data-bot-entry="${bot}"] .bot-row`)).toHaveClass(/selected/)
}

test("bot and conversation navigation survives copying, reload and browser back/forward", async ({ page }) => {
  await page.goto(entry)
  await expectLocation(page, "sidebar-bot-2", "sidebar-thread-2")
  const initialLength = await page.evaluate(() => history.length)
  await page.locator('[data-bot-entry="sidebar-bot-3"] .bot-row-main').click()
  await expectLocation(page, "sidebar-bot-3", "sidebar-thread-3")
  await page.locator('[data-bot-entry="sidebar-bot-2"] .bot-row-main').click()
  await page.locator(".thread-row").filter({ hasText: "Critérios de aceite" }).click()
  await expectLocation(page, "sidebar-bot-2", "sidebar-qa-history-0")
  await expect(page.locator(".thread-row").filter({ hasText: "Critérios de aceite" })).toHaveClass(/selected/)
  const shared = page.url()
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 3)

  await page.reload()
  await expectLocation(page, "sidebar-bot-2", "sidebar-qa-history-0")
  await expect(page.locator(".thread-row").filter({ hasText: "Critérios de aceite" })).toHaveClass(/selected/)
  expect(page.url()).toBe(shared)
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 3)
  await page.goBack()
  await expectLocation(page, "sidebar-bot-2", "sidebar-thread-2")
  await page.goBack()
  await expectLocation(page, "sidebar-bot-3", "sidebar-thread-3")
  await page.goBack()
  await expectLocation(page, "sidebar-bot-2", "sidebar-thread-2")
  await page.goForward()
  await expectLocation(page, "sidebar-bot-3", "sidebar-thread-3")
  await page.goForward()
  await expectLocation(page, "sidebar-bot-2", "sidebar-thread-2")
  await page.goForward()
  await expectLocation(page, "sidebar-bot-2", "sidebar-qa-history-0")
  expect(page.url()).toBe(shared)

  const copied = await page.context().newPage()
  await copied.goto(shared)
  await expectLocation(copied, "sidebar-bot-2", "sidebar-qa-history-0")
  await expect(copied.locator(".thread-row").filter({ hasText: "Critérios de aceite" })).toHaveClass(/selected/)
  await copied.close()
})

test("initial deep links replace in place and preserve unrelated query parameters and fragments", async ({ page }) => {
  await page.goto(`${entry}?thread=sidebar-thread-3&mode=web#chat`)
  await expectLocation(page, "sidebar-bot-3", "sidebar-thread-3")
  const length = await page.evaluate(() => history.length)
  await page.locator('[data-bot-entry="sidebar-bot-3"] .bot-row-main').click()
  expect(await page.evaluate(() => history.length)).toBe(length)
  await expect(page).toHaveURL((url) => url.searchParams.get("mode") === "web" && url.hash === "#chat")
  await page.reload()
  await expectLocation(page, "sidebar-bot-3", "sidebar-thread-3")
  expect(await page.evaluate(() => history.length)).toBe(length)
})
