import { mkdir } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const getTargetRules = (page: Page) =>
  new AxeBuilder({ page })
    .withRules(["target-size"])
    .include(".bot-sidebar")
    .analyze()
    .then((result) => result.violations.flatMap((violation) => violation.nodes.map((node) => node.target.join(" "))))

const getSmallTargets = (page: Page, minimum: number) =>
  page.evaluate((min) => {
    const selector = ".bot-sidebar :is(button, summary, a)"
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0)
      .filter(({ box }) => box.width < min || box.height < min)
      .map(
        ({ element, box }) =>
          `${element.getAttribute("aria-label") ?? element.textContent?.trim()} ${Math.round(box.width)}x${Math.round(box.height)}`,
      )
  }, minimum)

const capture = async (page: Page, name: string) => {
  const dir = process.env.SIDEBAR_CAPTURE
  if (!dir) return
  await mkdir(dir, { recursive: true })
  await page.locator(".bot-sidebar").screenshot({ path: `${dir}/${name}.png` })
}

const themes = ["light", "dark"] as const

themes.forEach((theme) => {
  test.describe(`sidebar targets (${theme})`, () => {
    test.use({ colorScheme: theme })
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
    })

    test("desktop sidebar controls are at least 40px with no overlapping targets", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto("/test/e2e/home-harness.html")
      await expect(page.locator(".bot-sidebar")).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await page.evaluate(() => document.fonts.ready)
      await capture(page, `desktop-${theme}`)

      const preview = page.locator('[data-bot-entry="bot-mark"] .bot-preview')
      expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await getSmallTargets(page, 40)).toEqual([])
      expect(await getTargetRules(page)).toEqual([])
    })

    test("phone drawer controls are at least 44px with no overlapping targets", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto("/test/e2e/home-harness.html")
      await page.getByRole("button", { name: "Abrir menu" }).click()
      await expect(page.getByRole("dialog", { name: "Barra lateral" })).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await page.evaluate(() => document.fonts.ready)
      await capture(page, `phone-${theme}`)

      expect(await getSmallTargets(page, 44)).toEqual([])
      expect(await getTargetRules(page)).toEqual([])
    })

    test("phone message edit link is at least 44px", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto("/test/e2e/home-harness.html")

      const edit = page.getByRole("button", { name: "Editar", exact: true }).first()
      await expect(edit).toBeVisible()
      const box = await edit.boundingBox()

      expect(box?.height).toBeGreaterThanOrEqual(44)
      expect(box?.width).toBeGreaterThanOrEqual(44)
    })
  })
})
