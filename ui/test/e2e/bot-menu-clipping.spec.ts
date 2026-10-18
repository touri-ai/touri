import { expect, type Locator, type Page, test } from "@playwright/test"

test.use({ channel: "chromium" })
const phase = process.env.MENU_EVIDENCE_PHASE ?? "after"
// Share the geometry reference while allowing native font rasterization on desktop.
const screenshotOptions = {
  animations: "disabled" as const,
  maxDiffPixelRatio: process.platform === "darwin" ? 0.02 : 0,
}

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

const themeColor = (surface: Locator, token: string) =>
  surface.evaluate((element, property) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${property})`
    element.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)

const borderlessRows = async (surface: Locator) => {
  for (const row of await surface.locator("button").all()) {
    expect(
      await row.evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
      }),
    ).toEqual(["0px", "0px", "0px", "0px"])
    await expect(row).toHaveCSS("font-size", "12px")
  }
}

for (const theme of ["light", "dark"]) {
  test.describe(`portaled menu styles in ${theme}`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" })

    test("bot and project menus retain plain rows, theme colors and interaction states", async ({ page }, info) => {
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
      await openWorkspace(page)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const trigger = page.getByRole("button", { name: "Ações de release", exact: true })
      await trigger.scrollIntoViewIfNeeded()
      await trigger.click()
      const menu = page.getByRole("menu", { name: "Ações de release", exact: true })
      await exposed(page, menu)
      await page.mouse.move(1100, 20)
      const botScreenshot = info.outputPath(`${phase}-bot-menu-${theme}.png`)
      await page.screenshot({ path: botScreenshot, animations: "disabled" })
      await info.attach(`bot menu ${theme}`, { path: botScreenshot, contentType: "image/png" })
      expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(true)
      await borderlessRows(menu)
      await expect.soft(menu).toHaveScreenshot(`bot-menu-${theme}.png`, screenshotOptions)
      const advanced = menu.getByRole("menuitem", { name: "Avançado", exact: true })
      const routines = menu.getByRole("menuitem", { name: "Rotinas", exact: true })
      const remove = menu.getByRole("menuitem", { name: "Excluir bot", exact: true })
      const primary = await themeColor(menu, "--text-primary")
      const danger = await themeColor(menu, "--text-danger")
      const control = await themeColor(menu, "--surface-control")
      await expect(advanced).toHaveCSS("color", primary)
      await expect(routines).toHaveCSS("color", primary)
      await expect(remove).toHaveCSS("color", danger)
      for (const row of [advanced, routines, remove])
        await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
      await routines.hover()
      await expect(routines).toHaveCSS("background-color", control)
      await page.mouse.move(1100, 20)
      await page.keyboard.press("Home")
      await expect(advanced).toBeFocused()
      await expect(advanced).toHaveCSS("outline-style", "solid")
      await expect(advanced).toHaveCSS("outline-width", "2px")
      await expect(advanced).toHaveCSS("outline-offset", "-2px")
      await expect(advanced).toHaveCSS("background-color", control)
      await page.keyboard.press("End")
      await expect(remove).toBeFocused()
      await expect(remove).toHaveCSS("color", danger)
      await expect(remove).toHaveCSS("background-color", await themeColor(menu, "--surface-notice"))
      await page.keyboard.press("Escape")

      await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
      await page.getByRole("button", { name: /^Projeto do bot:/ }).click()
      const projects = page.getByRole("menu", { name: "Projeto do bot" })
      await exposed(page, projects)
      await page.mouse.move(1100, 20)
      const projectScreenshot = info.outputPath(`${phase}-project-menu-${theme}.png`)
      await page.screenshot({ path: projectScreenshot, animations: "disabled" })
      await info.attach(`project menu ${theme}`, { path: projectScreenshot, contentType: "image/png" })
      expect(
        await projects.evaluate(
          (element) => element.closest(".composer-project-picker")?.parentElement === document.body,
        ),
      ).toBe(true)
      await borderlessRows(projects)
      await expect.soft(projects).toHaveScreenshot(`project-menu-${theme}.png`, screenshotOptions)
      for (const row of await projects.locator("button").all()) {
        await expect(row).toHaveCSS("color", primary)
        await expect(row).toHaveCSS(
          "background-color",
          (await row.getAttribute("aria-checked")) === "true"
            ? await themeColor(projects, "--surface-active")
            : "rgba(0, 0, 0, 0)",
        )
      }
      const add = projects.getByRole("menuitem", { name: "Adicionar projeto…" })
      await add.hover()
      await expect(add).toHaveCSS("background-color", control)
      await page.mouse.move(1100, 20)
      await page.keyboard.press("End")
      await expect(add).toBeFocused()
      await expect(add).toHaveCSS("outline-width", "2px")
      await expect(add).toHaveCSS("outline-offset", "-2px")
      await expect(add).toHaveCSS("background-color", control)
    })
  })
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
      await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
      await exposed(page, page.getByRole("navigation", { name: "Opções avançadas" }))
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: /^Notificações/ }).click()
      await exposed(page, page.getByRole("region", { name: "Central de notificações" }))
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Ações do grupo Planejamento" }).click()
      await page.getByRole("menuitem", { name: "Editar grupo", exact: true }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
      await page.getByRole("button", { name: "Fechar painel do bot", exact: true }).click()
      await expect(page.getByRole("button", { name: "Painel do bot", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false",
      )
      await page.getByRole("button", { name: /^Projeto do bot:/ }).click()
      const projectMenu = page.getByRole("menu", { name: "Projeto do bot" })
      await exposed(page, projectMenu)
      await page.getByRole("button", { name: /^Projeto do bot:/ }).click()
      await expect(projectMenu).toHaveCount(0)
      await expect(page.getByRole("button", { name: /^Projeto do bot:/ })).toBeFocused()
      await page.getByRole("button", { name: /^Projeto do bot:/ }).click()
      await projectMenu.getByRole("menuitemradio").first().click()
      await expect(projectMenu).toHaveCount(0)
      await expect(page.getByRole("button", { name: /^Projeto do bot:/ })).toBeFocused()
      await page.getByRole("button", { name: /^Projeto do bot:/ }).click()
      await page.keyboard.press("Escape")
      await expect(page.getByRole("button", { name: /^Projeto do bot:/ })).toBeFocused()
    })
  })
}

test("bot menu flips and shifts after resizing, tracks scrolling, and stays in the mobile top layer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await openWorkspace(page)

  // Let the list reach the viewport edge so the trigger cannot fit a menu below it.
  await page.addStyleTag({
    content: ".group-sidebar, .sidebar-footer, .sidebar-recovery { display: none !important; }",
  })
  // Activity groups determine the last row; the fixture's insertion order does not.
  const trigger = page
    .locator(".bot-sidebar .bot-row")
    .last()
    .getByRole("button", { name: /^Ações de / })
  const menuName = await trigger.getAttribute("aria-label")
  if (!menuName) throw new Error("Missing last bot menu label")

  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const menu = page.getByRole("menu", { name: menuName, exact: true })
  await exposed(page, menu)
  const rect = await menu.boundingBox()
  const anchor = await trigger.boundingBox()
  if (!rect || !anchor) throw new Error("Missing menu flip geometry")

  expect(anchor.y + anchor.height).toBeGreaterThan(600 - rect.height)
  expect(rect.y + rect.height).toBeLessThanOrEqual(anchor.y)
  await page.setViewportSize({ width: 700, height: 500 })
  // Leave room for the next scroll so viewport clamping cannot mask anchor tracking.
  await page.addStyleTag({ content: ".bot-groups { padding-bottom: 60px !important; }" })
  await page.locator(".bot-groups").evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
  await exposed(page, menu)
  const beforeScroll = await menu.boundingBox()
  if (!beforeScroll) throw new Error("Missing menu before scrolling")

  await page.locator(".bot-groups").evaluate((element) => {
    element.scrollTop -= 20
  })
  await exposed(page, menu)
  await expect
    .poll(async () => {
      const afterScroll = await menu.boundingBox()
      return afterScroll ? afterScroll.y - beforeScroll.y : Number.NaN
    })
    .toBeCloseTo(20, 0)
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 390, height: 600 })
  await page.getByRole("button", { name: "Abrir menu" }).click()
  const mobileTrigger = page.getByRole("button", { name: menuName, exact: true })
  await mobileTrigger.scrollIntoViewIfNeeded()
  await mobileTrigger.click()
  await exposed(page, menu)
  await page.keyboard.press("Escape")
  await expect(mobileTrigger).toBeFocused()
  await expect(page.locator(".sidebar-drawer")).toHaveAttribute("open", "")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Abrir menu" })).toBeFocused()
})
