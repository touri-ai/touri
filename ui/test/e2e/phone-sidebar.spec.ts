import { mkdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", viewport: { width: 390, height: 844 } })
test.setTimeout(90_000)

const shots = process.env.PHONE_SHOTS
const modes = ["bots", "work"] as const
const themes = ["light", "dark"] as const

const openDrawer = async (page: Page, theme: (typeof themes)[number], mode: (typeof modes)[number]) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript(
    ([appearance, sidebarMode]) => {
      localStorage.setItem("touri.appearance.v1", appearance ?? "")
      localStorage.setItem("touri.sidebar.mode", sidebarMode ?? "")
    },
    [theme, mode],
  )
  await page.goto("/test/e2e/work-mode-harness.html?rich")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.locator(".mobile-menu-button").click()
  await expect(page.getByRole("dialog", { name: "Barra lateral" })).toBeVisible()
  await expect(page.getByRole("tab", { name: mode === "work" ? /^Work,/ : /^Bots,/ })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await page.evaluate(() => document.fonts.ready)
}

const getSmallTargets = (page: Page) =>
  page.evaluate(() => {
    const selector = ".bot-sidebar :is(button, summary, a, [role=tab], .bot-row-main, .thread-row, .group-select)"
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0)
      .filter(({ element, box }) => box.width < 44 || box.height < (element.matches(".group-select") ? 40 : 44))
      .map(
        ({ element, box }) =>
          `${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 20)} ${Math.round(box.width)}x${Math.round(box.height)}`,
      )
  })

themes.forEach((theme) => {
  modes.forEach((mode) => {
    test.describe(`phone sidebar · ${mode} · ${theme}`, () => {
      test("header buttons sit fully inside the drawer and every target is at least 44px", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" })
        await openDrawer(page, theme, mode)
        const sidebar = await page.locator(".bot-sidebar").boundingBox()
        const row = await page.locator(".bot-sidebar .traffic-light-row").boundingBox()
        expect(sidebar?.y).toBeGreaterThanOrEqual(0)
        const names = mode === "bots" ? ["Fechar menu", "Criar bot", "Buscar conversas"] : ["Fechar menu"]
        for (const name of names) {
          const box = await page.locator(".bot-sidebar").getByRole("button", { name }).first().boundingBox()
          expect(box, name).not.toBeNull()
          expect(box?.y ?? -1, `${name} top`).toBeGreaterThanOrEqual(row?.y ?? 0)
          expect((box?.y ?? 0) + (box?.height ?? 0), `${name} bottom`).toBeLessThanOrEqual(
            (row?.y ?? 0) + (row?.height ?? 0),
          )
          expect(box?.height, `${name} height`).toBeGreaterThanOrEqual(44)
          expect(box?.width, `${name} width`).toBeGreaterThanOrEqual(44)
        }
        expect(await getSmallTargets(page)).toEqual([])
        expect(
          await page.evaluate(() => ({
            page: document.documentElement.scrollWidth <= window.innerWidth,
            sidebar: Array.from(document.querySelectorAll<HTMLElement>(".bot-sidebar, .bot-sidebar *")).every(
              (element) =>
                element.scrollWidth <= element.clientWidth + 1 || getComputedStyle(element).overflowX !== "visible",
            ),
          })),
        ).toEqual({ page: true, sidebar: true })
        if (!shots) return
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: `${shots}/${process.env.PHONE_SHOTS_PREFIX ?? "after"}-${mode}-${theme}.png` })
      })
    })
  })
})

test("drawer slides in and out smoothly, and not at all with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await openDrawer(page, "light", "work")
  const slide = () =>
    page
      .locator(".sidebar-drawer .bot-sidebar")
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration))
  expect(await slide()).toBeGreaterThan(0)
  const fade = await page
    .locator(".sidebar-drawer")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element, "::backdrop").transitionDuration))
  expect(fade).toBeGreaterThan(0)

  await page.getByRole("button", { name: "Fechar menu" }).click()
  await expect(page.getByRole("dialog", { name: "Barra lateral" })).toBeHidden()

  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.locator(".mobile-menu-button").click()
  expect(await slide()).toBe(0)
})
