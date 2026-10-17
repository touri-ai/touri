import { expect, type Locator, type Page, test } from "@playwright/test"

const phase = process.env.MENU_EVIDENCE_PHASE ?? "after"

const exposed = async (page: Page, surface: Locator) => {
  await expect(surface).toBeInViewport({ ratio: 1 })
  const rect = await surface.boundingBox()
  const viewport = page.viewportSize()
  if (!rect || !viewport) throw new Error("Missing menu geometry")
  expect(rect.x).toBeGreaterThanOrEqual(7)
  expect(rect.y).toBeGreaterThanOrEqual(7)
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width - 7)
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height - 7)
  for (const button of await surface.getByRole("button").all()) await button.click({ trial: true })
  for (const button of await surface.getByRole("menuitem").all()) await button.click({ trial: true })
  for (const button of await surface.getByRole("menuitemradio").all()) await button.click({ trial: true })
}

const openWorkspace = async (page: Page) => {
  await page.goto("/test/e2e/r8-sidebar-harness.html?menus")
  await expect(page.getByRole("textbox", { name: "Mensagem para touri-qa" })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 900, height: 600 },
]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: "reduce" })

    test("bot actions escape the bots/groups split and preserve pointer, keyboard and focus", async ({
      page,
    }, info) => {
      await openWorkspace(page)
      const trigger = page.getByRole("button", { name: "Ações de release", exact: true })
      await trigger.scrollIntoViewIfNeeded()
      await trigger.click()
      const menu = page.getByRole("menu", { name: "Ações de release", exact: true })
      const split = await page.locator(".bot-groups").boundingBox()
      const anchor = await trigger.boundingBox()
      if (!split || !anchor) throw new Error("Missing sidebar geometry")
      expect(split.y + split.height - anchor.y - anchor.height).toBeLessThan(60)
      await page.screenshot({ path: info.outputPath(`${phase}-bot-menu.png`) })
      await exposed(page, menu)
      await trigger.click()
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.click()
      await expect(menu.getByRole("menuitem", { name: "Avançado", exact: true })).toBeFocused()
      await page.keyboard.press("End")
      await expect(menu.getByRole("menuitem", { name: "Excluir bot", exact: true })).toBeFocused()
      await page.keyboard.press("ArrowDown")
      await expect(menu.getByRole("menuitem", { name: "Avançado", exact: true })).toBeFocused()
      await page.keyboard.press("ArrowUp")
      await expect(menu.getByRole("menuitem", { name: "Excluir bot", exact: true })).toBeFocused()
      await page.keyboard.press("Home")
      await page.keyboard.press("ArrowDown")
      await expect(menu.getByRole("menuitem", { name: "Rotinas", exact: true })).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.press("ArrowDown")
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("Enter")
      await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeVisible()
      await trigger.click()
      await menu.getByRole("menuitem", { name: "Excluir bot", exact: true }).click()
      const confirmation = page.getByRole("dialog", { name: "Excluir bot", exact: true })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await menu.getByRole("menuitem", { name: "Avançado", exact: true }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(trigger).toBeFocused()
    })

    test("other sidebar and chat popovers remain reachable", async ({ page }) => {
      await openWorkspace(page)
      await page.getByRole("button", { name: "Avançado", exact: true }).click()
      await exposed(page, page.getByRole("navigation", { name: "Opções avançadas" }))
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: /^Notificações/ }).click()
      await exposed(page, page.getByRole("region", { name: "Central de notificações" }))
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Editar grupo Planejamento" }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
      await page.getByRole("button", { name: "Projeto do bot" }).click()
      const projectMenu = page.getByRole("menu", { name: "Projeto do bot" })
      await exposed(page, projectMenu)
      await page.getByRole("button", { name: "Projeto do bot" }).click()
      await expect(projectMenu).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Projeto do bot" })).toBeFocused()
      await page.getByRole("button", { name: "Projeto do bot" }).click()
      await projectMenu.getByRole("menuitemradio").first().click()
      await expect(projectMenu).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Projeto do bot" })).toBeFocused()
      await page.getByRole("button", { name: "Projeto do bot" }).click()
      await page.keyboard.press("Escape")
      await expect(page.getByRole("button", { name: "Projeto do bot" })).toBeFocused()
    })
  })
}

test("bot menu flips and shifts after resizing, tracks scrolling, and stays in the mobile top layer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await openWorkspace(page)
  // Without groups the last bot is close to the viewport bottom, so the menu must flip upward.
  await page.locator(".group-sidebar").evaluate((element) => {
    ;(element as HTMLElement).style.display = "none"
  })
  const trigger = page.getByRole("button", { name: "Ações de release", exact: true })
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const menu = page.getByRole("menu", { name: "Ações de release", exact: true })
  await exposed(page, menu)
  const rect = await menu.boundingBox()
  const anchor = await trigger.boundingBox()
  expect(rect && anchor && rect.y + rect.height <= anchor.y).toBe(true)
  await page.setViewportSize({ width: 700, height: 500 })
  await exposed(page, menu)
  const beforeScroll = await menu.boundingBox()
  await page.locator(".bot-groups").evaluate((element) => {
    element.scrollTop -= 20
  })
  await exposed(page, menu)
  const afterScroll = await menu.boundingBox()
  expect(beforeScroll && afterScroll && afterScroll.y - beforeScroll.y).toBeCloseTo(20, 0)
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 600 })
  await page.getByRole("button", { name: "Abrir menu" }).click()
  const mobileTrigger = page.getByRole("button", { name: "Ações de release", exact: true })
  await mobileTrigger.scrollIntoViewIfNeeded()
  await mobileTrigger.click()
  await exposed(page, menu)
  await page.keyboard.press("Escape")
  await expect(mobileTrigger).toBeFocused()
  await expect(page.locator(".sidebar-drawer")).toHaveAttribute("open", "")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Abrir menu" })).toBeFocused()
})
