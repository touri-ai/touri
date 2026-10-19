import { expect, test } from "@playwright/test"

test("phone bot panel covers the menu icon and removes covered chat controls from access", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")

  await expect(page.getByRole("textbox", { name: /Mensagem para/ })).toBeVisible()
  const menu = page.locator(".mobile-menu-button")
  await expect(menu).toBeVisible()
  await page.getByRole("button", { name: "Painel do bot", exact: true }).click()

  const panel = page.locator("#bot-panel")
  const chat = page.locator(".chat-panel")
  await expect(panel).toBeVisible()
  await expect(menu).toBeHidden()
  await expect(chat).toHaveAttribute("inert", "")
  await expect(chat).toHaveAttribute("aria-hidden", "true")
  await expect(page.getByRole("button", { name: "Fechar painel do bot" })).toBeFocused()

  const headingIsOnTop = await panel.locator(".bot-panel-top > span").evaluate((heading) => {
    const bounds = heading.getBoundingClientRect()
    return Boolean(
      document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest("#bot-panel"),
    )
  })
  expect(headingIsOnTop).toBe(true)

  await page.keyboard.press("Tab")
  const focusIsInChat = await page.evaluate(() => Boolean(document.activeElement?.closest(".chat-panel")))
  expect(focusIsInChat).toBe(false)
})
