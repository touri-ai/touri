import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })

for (const [width, height, size] of [
  [1440, 900, "desktop"],
  [390, 844, "mobile"],
] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`message edit touch target at ${width}px in ${theme} theme`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height })
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)

      await page.goto("/?mockScenario=message-edit-target")

      await expect(
        page
          .getByTestId("virtual-message-list")
          .getByText("Revise a campanha antes da reunião de planejamento.", { exact: true }),
      ).toBeVisible()
      const edit = page.getByRole("button", { name: "Editar", exact: true })
      await expect(edit).toBeVisible()
      await page.addStyleTag({
        content: ".composer-model, .bot-model-line, .model-pill { visibility: hidden !important; }",
      })

      const baseline = await page.addStyleTag({
        content: "@media (max-width: 600px) { .text-button { min-width: 0 !important; min-height: 0 !important; } }",
      })
      const before = await edit.boundingBox()
      expect(before).not.toBeNull()
      if (width === 390) expect(before?.height).toBeLessThan(24)
      await page.screenshot({
        path: testInfo.outputPath(`before-${size}-${theme}.png`),
        animations: "disabled",
      })
      await baseline.evaluate((element) => element.remove())

      const after = await edit.boundingBox()
      if (width === 390) {
        expect(after?.width).toBeGreaterThanOrEqual(24)
        expect(after?.height).toBeGreaterThanOrEqual(24)
      }
      await page.screenshot({
        path: testInfo.outputPath(`after-${size}-${theme}.png`),
        animations: "disabled",
      })
    })
  }
}
