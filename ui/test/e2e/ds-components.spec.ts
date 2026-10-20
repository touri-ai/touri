import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce", viewport: { width: 1440, height: 900 } })

const capture = process.env.DS_COMPONENTS_CAPTURE

for (const theme of ["light", "dark"] as const) {
  test(`shared controls retain contrast, focus and inert content (${theme})`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
    await page.goto("/test/e2e/ds-components-harness.html")
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    const controls = page.locator("main > div > .ds-button")
    const getContrast = () => new AxeBuilder({ page }).include("main").withRules(["color-contrast"]).analyze()

    expect((await getContrast()).violations).toEqual([])
    for (const control of await controls.all()) {
      await page.keyboard.press("Tab")
      await expect(control).toBeFocused()
      await expect(control).toHaveCSS("outline-style", "solid")
      await expect(control).toHaveCSS("outline-width", "2px")
      await control.hover()
      if (capture && (await control.getAttribute("class"))?.includes("ds-button-primary"))
        await page.screenshot({ path: `${capture}/components-hover-${theme}.png` })

      expect((await getContrast()).violations).toEqual([])
    }

    const trigger = page.getByRole("button", { name: "Detalhes técnicos" })
    const panel = page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`)
    const inner = page.getByRole("button", { name: "Ação nos detalhes", includeHidden: true })
    await page.keyboard.press("Tab")
    await expect(trigger).toBeFocused()
    await expect(panel).toHaveAttribute("inert", "")
    await inner.evaluate((element) => element.focus())
    await expect(trigger).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: "Depois dos detalhes" })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await trigger.press("Enter")
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(panel).not.toHaveAttribute("inert")
    await expect(panel).toHaveCSS("transition-duration", "0s")
    await expect(trigger.locator("svg")).toHaveCSS("transition-duration", "0s")
    await page.keyboard.press("Tab")
    await expect(inner).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await trigger.press("Space")
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    await expect(panel).toHaveCSS("height", "0px")
  })
}

test("a searched setting receives focus after its collapsed section opens", async ({ page }) => {
  await page.goto("/test/e2e/notification-center-harness.html")
  await page.getByRole("button", { name: "Buscar conversas", exact: true }).click()
  const search = page.getByRole("dialog", { name: "Paleta de comandos" })
  await search.getByRole("combobox").fill("mover bots novidades")
  await search.getByRole("option", { name: /Mover bots com novidades para o topo/ }).click()
  const dialog = page.getByRole("dialog", { name: "Configurações", exact: true })
  const field = dialog.getByRole("switch", { name: "Mover bots com novidades para o topo" })
  await expect(field).toBeVisible()
  if (capture) await dialog.screenshot({ path: `${capture}/settings-focus.png` })

  await expect(field).toBeFocused()
})
