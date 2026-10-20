import { expect, test } from "@playwright/test"

const viewports = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]
const sections = ["Modelo", "Acesso", "Computador"]

viewports.forEach((viewport) => {
  test.describe(`bot settings at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, locale: "pt-BR", reducedMotion: "reduce" })

    sections.forEach((section) => {
      test(`${section} keeps descriptions and controls readable`, async ({ page }) => {
        await page.goto("/test/e2e/home-harness.html")
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

        await page.keyboard.press("Control+k")
        await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("Modelo do bot")
        await page.getByRole("option", { name: /^Modelo do bot/ }).click()
        const dialog = page.getByRole("dialog", { name: "Configurações de mark", exact: true })
        await dialog.getByRole("tab", { name: section, exact: true }).click()
        const pane = dialog.getByRole("tabpanel", { name: section, exact: true })
        const rows = pane.locator(".settings-row:visible, .machine-environment-row:visible")

        await expect(pane).toBeVisible()
        expect(await rows.count()).toBeGreaterThan(0)
        for (const row of await rows.all()) {
          await row.scrollIntoViewIfNeeded()
          const layout = await row.evaluate(getRowLayout)

          expect(layout.overflow).toBeLessThanOrEqual(1)
          if (viewport.width <= 540) {
            expect(layout.copy.width).toBeCloseTo(layout.contentWidth, 0)
            expect(layout.control.width).toBeCloseTo(layout.contentWidth, 0)
            expect(layout.control.y).toBeGreaterThanOrEqual(layout.copy.bottom)
            expect(layout.field.width).toBeCloseTo(layout.contentWidth, 0)
            continue
          }

          expect(layout.copy.width).toBeGreaterThan(100)
          expect(layout.control.x).toBeGreaterThanOrEqual(layout.copy.right)
          expect(layout.control.y).toBeLessThan(layout.copy.bottom)
          expect(layout.copy.y).toBeLessThan(layout.control.bottom)
        }

        expect(await pane.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      })
    })
  })
})

const getRowLayout = (row: Element) => {
  const copy = row.querySelector(".settings-row-copy, .machine-environment-copy")
  const control = row.querySelector(".settings-row-control, .machine-environment-control")
  const field = control?.querySelector("input, select, button.model-picker-trigger")
  if (!copy || !control || !field) throw new Error("Expected a settings description and its field")

  const style = getComputedStyle(row)
  const contentWidth = row.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)

  return {
    contentWidth,
    copy: copy.getBoundingClientRect().toJSON(),
    control: control.getBoundingClientRect().toJSON(),
    field: field.getBoundingClientRect().toJSON(),
    overflow: row.scrollWidth - row.clientWidth,
  }
}

test.describe("phone bot settings overview", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "pt-BR", reducedMotion: "reduce" })

  test("labels advanced settings and keeps them clear of the mascot colors", async ({ page }) => {
    await page.goto("/test/e2e/home-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    const sidebar = page.getByRole("dialog", { name: "Barra lateral", exact: true })
    await sidebar.getByRole("button", { name: "Ações de mark", exact: true }).click()
    await sidebar.getByRole("menuitem", { name: "Avançado", exact: true }).click()

    const dialog = page.getByRole("dialog", { name: "Configurações de mark", exact: true })
    const advanced = dialog.getByRole("button", { name: "Avançado Ajustes deste bot", exact: true })
    await expect(advanced).toBeVisible()
    await expect(dialog.getByText("Ajustes deste bot", { exact: true })).toBeVisible()

    const overview = dialog.locator(".bot-settings-overview")
    await overview.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const colors = dialog.locator(".avatar-colors")
    await expect(colors).toBeInViewport()
    const spacing = await dialog.evaluate((element) => {
      const colorRow = element.querySelector(".avatar-colors")
      const advancedBar = element.querySelector(".settings-advanced-bar")
      if (!colorRow || !advancedBar) throw new Error("Expected mascot colors and advanced settings")

      return {
        gap: advancedBar.getBoundingClientRect().top - colorRow.getBoundingClientRect().bottom,
        overflow: element.scrollWidth - element.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      }
    })

    expect(spacing.gap).toBeGreaterThanOrEqual(12)
    expect(spacing.overflow).toBe(0)
    expect(spacing.pageOverflow).toBe(0)
  })
})
