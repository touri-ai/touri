import { mkdir } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { showBotAdvanced } from "./home-navigation"

const output = process.env.TOURI_QA_SCREENSHOT_DIR
const cases = [390, 1440].flatMap((width) => ["dark", "light"].map((theme) => ({ width, theme })))

cases.forEach(({ width, theme }) => {
  test.describe(`mascot accessibility at ${width}px in ${theme} mode`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: "pt-BR", reducedMotion: "reduce" })

    test("mascot surfaces remain readable and keyboard accessible", async ({ page }) => {
      test.setTimeout(90000)
      await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
      await page.goto("/test/e2e/groups-harness.html")
      await openNavigation(page)
      await page.getByRole("button", { name: "Criar bot", exact: true }).click()
      await captureSurface(page, "bot-create", width, theme)
      await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click()

      await openNavigation(page)
      await page.getByRole("button", { name: "Criar grupo", exact: true }).click()
      await captureSurface(page, "group-create", width, theme)
      await page
        .getByRole("dialog", { name: "Criar grupo", exact: true })
        .getByRole("button", { name: "Cancelar", exact: true })
        .click()

      await page.goto("/test/e2e/groups-harness.html")
      await openNavigation(page)
      await showBotAdvanced(page, "mark")
      await captureSurface(page, "bot-settings", width, theme)
    })
  })
})

const openNavigation = async (page: Page) => {
  const trigger = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (!(await trigger.isVisible())) return

  await trigger.click()
}

const captureSurface = async (page: Page, surface: string, width: number, theme: string) => {
  const picker = page.locator(".avatar-picker:visible")
  await expect(picker).toBeVisible()
  if (output) {
    await mkdir(output, { recursive: true })
    await page.screenshot({ path: `${output}/after-${surface}-${width}-${theme}.png` })
  }

  expect(await picker.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const customize = picker.getByRole("button", { name: "Personalizar", exact: true })
  await customize.focus()
  await page.keyboard.press("Enter")
  await expect(customize).toHaveAttribute("aria-expanded", "true")
  await expect(picker.getByRole("radio", { name: "Chifres Longos", exact: true })).toBeVisible()
  const audit = await new AxeBuilder({ page })
    .include(".avatar-picker")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()
  expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([])
  if (output && surface === "group-create" && width === 390) {
    await picker.screenshot({ path: `${output}/after-group-expanded-${width}-${theme}.png` })
  }
  await customize.focus()
  await page.keyboard.press("Space")
  await expect(customize).toHaveAttribute("aria-expanded", "false")
}
