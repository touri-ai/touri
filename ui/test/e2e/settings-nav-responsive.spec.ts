import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })

test("phone settings navigation scrolls every tab into view for touch and keyboard", async ({ page }) => {
  await page.goto("/test/e2e/r8-settings-harness.html")
  await page.getByRole("button", { name: "Abrir menu" }).click()
  await page.getByRole("button", { name: /Você Local/ }).click()

  const dialog = page.getByRole("dialog")
  const tablist = dialog.getByRole("tablist")
  const tabs = tablist.getByRole("tab")
  await expect(tabs).toHaveCount(7)
  await expect(tabs).toContainText([
    "Modelos por API",
    "Aparência",
    "Privacidade",
    "Atualizações",
    "Notificações",
    "Diagnóstico",
    "Avançado",
  ])

  const layout = await tablist.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const tabs = Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]'))
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
      tabsFit: tabs.every((tab) => {
        const tabBounds = tab.getBoundingClientRect()
        return tab.scrollWidth <= tab.clientWidth && tabBounds.left >= bounds.left && tabBounds.right <= bounds.right
      }),
    }
  })

  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth)
  expect(layout.rows).toBe(1)
  expect(layout.tabsFit).toBe(false)

  const diagnosis = tablist.getByRole("tab", { name: "Diagnóstico", exact: true })
  await diagnosis.click()
  await expect(diagnosis).toHaveAttribute("aria-selected", "true")
  await expect(diagnosis).toBeInViewport()

  await tabs.first().click()
  const tabElements = await tabs.all()
  for (const [index, tab] of tabElements.entries()) {
    if (index > 0) await page.keyboard.press("ArrowRight")
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect(tab).toBeInViewport()
  }
})
