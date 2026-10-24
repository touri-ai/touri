import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })

const capture = process.env.DS_COMPONENTS_CAPTURE

const openCenter = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
  await page.goto("/test/e2e/notification-center-harness.html")
  if (width < 500) await page.getByRole("button", { name: "Abrir menu" }).click()
  await page.getByRole("button", { name: /^Notificações,/ }).click()

  return page.getByRole("region", { name: "Central de notificações" })
}

const getStyle = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element)

    const { height, width } = element.getBoundingClientRect()

    return { size: style.fontSize, weight: style.fontWeight, height, width }
  })

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`notification center follows the design system at ${width}px (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme as "dark" | "light" })
      await page.addInitScript((preference) => localStorage.setItem("touri.appearance.v1", preference), theme)
      const center = await openCenter(page, width)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const approval = center.locator('[data-kind="approval"]')

      expect(await getStyle(center.locator("header strong"))).toMatchObject({ size: "17px", weight: "600" })
      expect(await getStyle(approval.locator(".notification-head strong"))).toMatchObject({
        size: "13px",
        weight: "600",
      })
      expect(await getStyle(approval.locator(".notification-title"))).toMatchObject({ size: "15px", weight: "600" })
      expect(await getStyle(approval.locator(".notification-body"))).toMatchObject({ size: "13px" })
      const contrast = await new AxeBuilder({ page })
        .include(".notification-popover .ds-badge")
        .withRules(["color-contrast"])
        .analyze()
      expect(contrast.violations).toEqual([])

      const primary = approval.getByRole("button", { name: "Abrir e revisar" })
      const minimum = width < 500 ? 44 : 40
      const bell = page.getByRole("button", { name: /^Notificações,/ })
      expect((await getStyle(bell)).height).toBeGreaterThanOrEqual(minimum)
      expect((await getStyle(bell)).width).toBeGreaterThanOrEqual(minimum)
      expect((await getStyle(primary)).height).toBeGreaterThanOrEqual(minimum)
      expect(
        (await getStyle(center.getByRole("button", { name: "Limpar", exact: true }))).height,
      ).toBeGreaterThanOrEqual(minimum)
      expect(
        (await getStyle(center.getByRole("button", { name: "Fechar notificações" }))).height,
      ).toBeGreaterThanOrEqual(minimum)
      expect(
        (await getStyle(center.getByRole("button", { name: "Fechar notificações" }))).width,
      ).toBeGreaterThanOrEqual(minimum)
      await expect(approval.locator(".ds-button-primary")).toHaveCount(1)
      await expect(approval.getByRole("button", { name: "Aprovar" })).toHaveCount(0)

      await expect(approval.getByRole("button", { name: "Detalhes técnicos" })).toHaveCount(0)
      await expect(approval.locator("pre")).toHaveCount(0)

      if (capture) {
        await center.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await center.screenshot({ path: `${capture}/after-notifications-${width}-${theme}.png` })
      }
    })
  }
}

test("review stays reachable from the keyboard without technical controls in the bell", async ({ page }) => {
  const center = await openCenter(page, 1440)
  const primary = center.locator('[data-kind="approval"]').getByRole("button", { name: "Abrir e revisar" })

  await primary.focus()
  await page.keyboard.press("Enter")

  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await expect(center).toBeHidden()
})
