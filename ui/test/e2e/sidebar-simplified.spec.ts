import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Locator, type Page, test } from "@playwright/test"

const scenarios = [1440, 1024, 390].flatMap((width) => ["light", "dark"].map((theme) => ({ width, theme })))
const interactionWidths = [1440, 390]

scenarios.forEach(({ width, theme }) => {
  test(`bot selection stays flat and channel controls fit at ${width}px in ${theme}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "bots"))
    await page.goto("/test/e2e/work-mode-harness.html?rich")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
    await page.mouse.move(width - 1, 1)
    const controlsBefore = await getVisibleControlCount(sidebar)
    const rowControlsBefore = await getVisibleControlCount(sidebar.locator("#sidebar-mode-panel-bots"))

    await page.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
    await page.mouse.move(width - 1, 1)

    await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.mouse.move(width - 1, 1)

    await expect.poll(() => getVisibleControlCount(sidebar)).toBe(controlsBefore)
    await expect.poll(() => getVisibleControlCount(sidebar.locator("#sidebar-mode-panel-bots"))).toBe(rowControlsBefore)
    await expect(sidebar.locator(".bot-thread-tree")).toHaveCount(0)
    const botRow = sidebar.locator('[data-bot-entry="bot-onb"] .bot-row')
    expect((await botRow.boundingBox())?.height).toBeLessThanOrEqual(56)
    await capture(page, `bots-${width}-${theme}`)

    await page.getByRole("tab", { name: /^Work,/ }).click()
    const channel = sidebar.getByRole("button", { name: /^Planejamento/ })
    const row = channel.locator("..")
    const geometry = await row.evaluate((element) => {
      const hash = element.querySelector(".channel-hash")?.getBoundingClientRect()
      const name = element.querySelector(".channel-name")?.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      if (!hash || !name) throw new Error("Missing channel row")

      return {
        centerDifference: Math.abs(hash.y + hash.height / 2 - name.y - name.height / 2),
        nameWithinRow: name.y >= bounds.y && name.bottom <= bounds.bottom,
      }
    })

    expect(geometry.centerDifference).toBeLessThanOrEqual(2)
    expect(geometry.nameWithinRow).toBe(true)
    await expect(sidebar.locator(".channel-bot-avatars")).toHaveCount(0)
    const sidebarContrast = await new AxeBuilder({ page })
      .include(".bot-sidebar")
      .withRules(["color-contrast"])
      .analyze()
    expect(sidebarContrast.violations).toEqual([])
    await capture(page, `work-${width}-${theme}`)
    await channel.click()
    const header = page.locator(".group-header")

    await expect(header.getByRole("button")).toHaveCount(2)
    await expect(header.locator(".chat-header-crumb")).toHaveCount(0)
    expect(await header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0)
    const channelContrast = await new AxeBuilder({ page })
      .include(".group-header")
      .include(".composer")
      .withRules(["color-contrast"])
      .analyze()
    expect(channelContrast.violations).toEqual([])
    await capture(page, `channel-${width}-${theme}`)
    if (width !== 390) return

    const targets = await header.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect()

        return bounds.width >= 44 && bounds.height >= 44
      }),
    )
    expect(targets.every(Boolean)).toBe(true)
  })
})

interactionWidths.forEach((width) => {
  test(`bot actions remain accessible by keyboard and deliberate pointer expansion at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "bots"))
    await page.goto("/test/e2e/work-mode-harness.html?rich")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
    const row = sidebar.locator(".bot-row").filter({
      has: page.getByRole("button", { name: "Ações de Bia", exact: true }),
    })
    const trigger = row.getByRole("button", { name: "Ações de Bia", exact: true })
    const main = row.locator(".bot-row-main")
    const menu = page.getByRole("menu", { name: "Ações de Bia", exact: true })
    await page.mouse.move(width - 1, 1)

    await page.keyboard.press("Tab")
    await main.focus()

    await expect(main).toBeFocused()
    expect(await main.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    expect(await getVisibleControlCount(row.locator(".bot-actions-menu"))).toBe(1)

    await page.keyboard.press("Tab")

    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS("outline-style", "solid")
    await expect(trigger).toHaveCSS("outline-width", "2px")

    await page.keyboard.press("Enter")

    await expect(menu.getByRole("menuitem", { name: "Nova conversa", exact: true })).toBeFocused()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(await getVisibleControlCount(row.locator(".bot-actions-menu"))).toBe(1)

    await page.keyboard.press("Escape")

    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()

    await row.hover()
    await trigger.click()
    await page.mouse.move(width - 1, 1)

    await expect(menu).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(await getVisibleControlCount(row.locator(".bot-actions-menu"))).toBe(1)
  })
})

test.describe("touch bot actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })

  test("selected bot management remains available and selection adds no visible sidebar controls", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "bots"))
    await page.goto("/test/e2e/work-mode-harness.html?rich")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await page.getByRole("button", { name: "Abrir menu", exact: true }).tap()
    const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
    const selectedRow = sidebar.locator('[data-bot-entry="bot-mark"] .bot-row')
    const row = sidebar.locator('[data-bot-entry="bot-onb"] .bot-row')
    const controlsBefore = await getVisibleControlCount(sidebar)

    expect(await getVisibleControlCount(selectedRow.locator(".bot-actions-menu"))).toBe(1)
    expect(await getVisibleControlCount(row.locator(".bot-actions-menu"))).toBe(0)

    await row.locator(".bot-row-main").tap()

    await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
    await page.getByRole("button", { name: "Abrir menu", exact: true }).tap()

    await expect.poll(() => getVisibleControlCount(sidebar)).toBe(controlsBefore)
    expect(await getVisibleControlCount(row.locator(".bot-actions-menu"))).toBe(1)

    await row.getByRole("button", { name: "Ações de onb", exact: true }).tap()

    const menu = page.getByRole("menu", { name: "Ações de onb", exact: true })
    await expect(menu.getByRole("menuitem", { name: "Avançado", exact: true })).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: "Excluir bot", exact: true })).toBeVisible()
  })
})

const getVisibleControlCount = (surface: Locator): Promise<number> =>
  surface.locator('button, a[href], input, select, textarea, summary, [role="button"], [role="tab"]').evaluateAll(
    (controls) =>
      controls.filter((control) => {
        if (!control.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false

        const bounds = control.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return false

        // Hit testing also excludes controls clipped by a collapsed action slot or a scroll container.
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

        return hit !== null && control.contains(hit)
      }).length,
  )

const capture = async (page: Page, name: string): Promise<void> => {
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(directory, `after-${name}.png`), animations: "disabled" })
}
