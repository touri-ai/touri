import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

for (const width of [1440, 390]) {
  for (const scenario of ["recovered", "empty"]) {
    test(`${scenario} provider reply stays readable at ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const capture = async (phase: string) => {
        const path = process.env.PROVIDER_REPLY_CAPTURE
          ? `${process.env.PROVIDER_REPLY_CAPTURE}/${phase}-${scenario}-${width}.png`
          : info.outputPath(`${phase}-${scenario}-${width}.png`)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path, animations: "disabled" })
        await info.attach(`${phase} ${scenario} ${width}`, { path, contentType: "image/png" })
      }
      await page.goto("/test/e2e/provider-reply-harness.html?scenario=before")
      await expect(page.getByRole("alert")).toBeVisible()
      await capture("before")

      await page.goto(`/test/e2e/provider-reply-harness.html?scenario=${scenario}`)
      if (scenario === "recovered") {
        await expect(page.getByTestId("virtual-message-list").getByText("Resposta preservada.")).toBeVisible()
        await expect(page.getByRole("alert")).toHaveCount(0)
      } else {
        await expect(page.getByRole("alert")).toContainText("O provedor terminou sem responder. Tente de novo.")
        await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeVisible()
      }
      await capture("after")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      const accessibility = await new AxeBuilder({ page })
        .include('[data-testid="virtual-message-list"]')
        .withRules(["color-contrast", "button-name"])
        .analyze()
      expect(accessibility.violations).toEqual([])
    })
  }
}
