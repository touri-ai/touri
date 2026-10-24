import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Locator, test } from "@playwright/test"

const names = ["Apoio equipe azul QA", "Apoio equipe verde QA"] as const
const viewports = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]

viewports
  .flatMap((viewport) => ["light", "dark"].map((theme) => ({ viewport, theme })))
  .forEach(({ viewport, theme }) => {
    test(`channel picker keeps similar names readable and independently selectable at ${viewport.width} in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport)
      await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
      await page.goto("/test/e2e/channel-member-picker-harness.html")
      const dialog = page.getByRole("dialog", { name: "Criar canal", exact: true })
      const labels = dialog.locator(".group-member-picker label")
      const blue = dialog.getByRole("checkbox", { name: names[0], exact: true })
      const green = dialog.getByRole("checkbox", { name: names[1], exact: true })

      await expect(blue).not.toBeChecked()
      await expect(green).not.toBeChecked()
      await expect(labels).toHaveCount(2)
      await expectReadableName(labels.nth(0), names[0])
      await expectReadableName(labels.nth(1), names[1])
      const bounds = await labels.evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().toJSON()))
      if (viewport.width === 390) expect(bounds[1]?.top).toBeGreaterThanOrEqual(bounds[0]?.bottom)
      if (viewport.width === 1440) expect(bounds[1]?.top).toBe(bounds[0]?.top)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      const violations = (
        await new AxeBuilder({ page }).include(".group-modal").withTags(["wcag2a", "wcag2aa"]).analyze()
      ).violations
      expect(violations).toEqual([])
      await page.screenshot({
        path: join(
          process.env.TOURI_E2E_EVIDENCE_DIR ?? testInfo.outputDir,
          `channel-picker-${viewport.width}-${theme}.png`,
        ),
      })

      await labels.nth(0).getByText(names[0], { exact: true }).click()

      await expect(blue).toBeChecked()
      await expect(green).not.toBeChecked()

      await labels.nth(1).getByText(names[1], { exact: true }).click()

      await expect(blue).toBeChecked()
      await expect(green).toBeChecked()
      await expectReadableName(labels.nth(0), names[0])
      await expectReadableName(labels.nth(1), names[1])

      await blue.uncheck()

      await expect(blue).not.toBeChecked()
      await expect(green).toBeChecked()

      await green.uncheck()

      await expect(green).not.toBeChecked()

      await blue.focus()
      await blue.press("Space")

      await expect(blue).toBeFocused()
      await expect(blue).toBeChecked()
      await expect(green).not.toBeChecked()

      await dialog.getByRole("textbox", { name: "Nome do canal", exact: true }).fill("Equipe QA")
      const saved = page.evaluate(
        () =>
          new Promise((resolve) => {
            window.addEventListener(
              "channel-picker-save",
              (event) => {
                if (event instanceof CustomEvent) resolve(event.detail)
              },
              { once: true },
            )
          }),
      )

      await dialog.getByRole("button", { name: "Criar canal", exact: true }).click()

      expect(await saved).toMatchObject({ name: "Equipe QA", memberIds: ["support-0"] })
    })
  })

const expectReadableName = async (label: Locator, name: string) => {
  const text = label.locator(":scope > span:not(.tb-avatar)")

  await label.scrollIntoViewIfNeeded()
  await expect(text).toHaveText(name)
  await expect(text).toBeInViewport({ ratio: 1 })
  const layout = await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const textBounds = element.getBoundingClientRect()
    const labelBounds = element.closest("label")?.getBoundingClientRect()
    const fragments = Array.from(range.getClientRects())

    return {
      uncut: fragments.every(
        (fragment) =>
          fragment.left >= textBounds.left - 1 &&
          fragment.right <= textBounds.right + 1 &&
          fragment.top >= textBounds.top - 1 &&
          fragment.bottom <= textBounds.bottom + 1,
      ),
      width: labelBounds?.width ?? 0,
      height: labelBounds?.height ?? 0,
    }
  })

  expect(layout.uncut, `${name} must fit inside its visible text bounds`).toBe(true)
  expect(layout.width).toBeGreaterThanOrEqual(44)
  expect(layout.height).toBeGreaterThanOrEqual(44)
}
