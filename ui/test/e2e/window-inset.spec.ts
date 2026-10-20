import { expect, type Locator, type Page, test } from "@playwright/test"

test.setTimeout(90_000)

const sizes = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
  { width: 390, height: 844 },
]
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"

test.use({ userAgent })

const themes = ["light", "dark"]

themes.forEach((theme) => {
  sizes.forEach((viewport) => {
    test.describe(`window inset · ${theme} · ${viewport.width}`, () => {
      test.use({ viewport, userAgent, reducedMotion: "reduce" })

      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
      })

      test("notices, dialogs and recovery leave the native controls clear", async ({ page }) => {
        await page.goto("/test/e2e/window-inset-harness.html?scene=notice")
        const banner = page.locator(".notice-bar")
        await expect(banner).toBeVisible()

        await checkTitlebar(page)
        await checkBelowTitlebar(banner)
        await banner.getByRole("button", { name: "Dispensar aviso" }).click()
        await expect(banner).toHaveCount(0)
        await checkTitlebar(page)
        await page.getByRole("button", { name: /^Escolher modelo:/ }).click()
        const modelMenu = page.locator(".model-picker-popover")
        await checkBelowTitlebar(modelMenu)
        await page.keyboard.press("Escape")
        await expect(modelMenu).toHaveCount(0)

        await page.goto("/test/e2e/window-inset-harness.html?scene=error")
        await expect(page.locator(".error-card")).toBeVisible()
        await checkTitlebar(page)
        await checkBelowTitlebar(page.locator(".error-card"))
        const report = page.getByRole("button", { name: "Reportar este problema", exact: true })
        await report.scrollIntoViewIfNeeded()
        await expect(report).toBeInViewport({ ratio: 1 })
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      })

      test("scrolling option menus stay between the titlebar and viewport bottom", async ({ page }) => {
        await page.goto("/test/e2e/window-inset-harness.html?scene=menu")
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

        await page.getByRole("button", { name: /^Projeto do bot:/ }).click()
        const picker = page.locator(".composer-project-picker")
        await checkBelowTitlebar(picker)
        await expect(picker).toBeInViewport({ ratio: 1 })
        const lastProject = picker.getByRole("menuitemradio").last()
        await lastProject.scrollIntoViewIfNeeded()

        await expect(lastProject).toBeInViewport({ ratio: 1 })
        await lastProject.click({ trial: true })
      })

      test("sidebar shares its header with actions below the native titlebar", async ({ page }) => {
        await page.goto("/test/e2e/window-inset-harness.html?scene=workspace")
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        if (viewport.width <= 620) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
        const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
        const heading = sidebar.locator(".sidebar-list-heading")
        const search = sidebar.getByRole("button", { name: "Buscar conversas", exact: true })
        const create = sidebar.getByRole("button", { name: "Criar bot", exact: true })

        const sidebarBox = await sidebar.boundingBox()
        const headingBox = await heading.boundingBox()
        const searchBox = await search.boundingBox()
        const createBox = await create.boundingBox()
        if (!sidebarBox || !headingBox || !searchBox || !createBox) throw new Error("Sidebar geometry unavailable")

        await expect(page.locator("html")).toHaveAttribute("data-window-overlay", "true")
        expect(headingBox.y).toBe(sidebarBox.y)
        expect(headingBox.y).toBeGreaterThanOrEqual(44)
        expect(searchBox.y).toBeGreaterThanOrEqual(headingBox.y)
        expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(headingBox.y + headingBox.height)
        expect(createBox.y).toBe(searchBox.y)
        expect(createBox.y + createBox.height).toBeLessThanOrEqual(headingBox.y + headingBox.height)
        await expect(sidebar.locator(".traffic-light-spacer")).toBeHidden()
        await search.click({ trial: true })
        await create.click()
        await expect(page.getByRole("dialog", { name: "Criar um bot", exact: true })).toBeVisible()
      })

      test("loading and onboarding retain a drag region", async ({ page }) => {
        await page.goto("/test/e2e/window-inset-harness.html?scene=loading")
        await expect(page.locator(".loading-screen")).toBeVisible()
        await checkTitlebar(page)
        await checkBelowTitlebar(page.locator(".loading-screen"))

        await page.goto("/test/e2e/window-inset-harness.html?scene=onboarding")
        await expect(page.getByRole("button", { name: "Criar meu primeiro bot" })).toBeVisible()
        await checkTitlebar(page)
        await checkBelowTitlebar(page.locator(".onboarding-card"))
      })
    })
  })
})

test("window inset does not reserve native chrome in the browser", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  await expect(page.locator(".window-titlebar")).toHaveCount(0)
  expect((await page.locator(".app-shell").boundingBox())?.y).toBe(0)
  await expect(page.locator(".traffic-light-row")).toHaveCSS("height", "44px")
})

test("window inset leaves decorated computer popups to the system titlebar", async ({ page }) => {
  await page.goto("/test/e2e/window-inset-harness.html?computer=bot-mark")
  await expect(page.locator(".computer-window")).toBeVisible()

  await expect(page.locator(".window-titlebar")).toHaveCount(0)
  expect((await page.locator(".computer-window").boundingBox())?.y).toBe(0)
})

test.describe("standard window recovery", () => {
  test.use({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", viewport: { width: 390, height: 700 } })

  test("recovery actions remain reachable when the card is taller than the window", async ({ page }) => {
    await page.goto("/test/e2e/window-inset-harness.html?scene=error")
    const report = page.getByRole("button", { name: "Reportar este problema", exact: true })
    await expect(page.locator(".error-card")).toBeVisible()

    await report.scrollIntoViewIfNeeded()

    await expect(report).toBeInViewport({ ratio: 1 })
    await report.click({ trial: true })
    await expect(page.locator(".window-titlebar")).toHaveCount(0)
  })
})

const checkTitlebar = async (page: Page) => {
  const titlebar = page.locator(".window-titlebar")

  await expect(titlebar).toBeVisible()
  await expect(titlebar).toHaveAttribute("data-tauri-drag-region", "deep")
  await expect(titlebar).toHaveCSS("height", "44px")
  expect((await titlebar.boundingBox())?.y).toBe(0)
}

const checkBelowTitlebar = async (surface: Locator) => {
  await expect(surface).toBeVisible()
  const box = await surface.boundingBox()

  expect(box?.y).toBeGreaterThanOrEqual(44)
}
