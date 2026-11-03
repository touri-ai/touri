import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const before = process.env.PROFILE_SHORTCUT_PHASE === "before"
const evidence = process.env.PROFILE_SHORTCUT_EVIDENCE

test.setTimeout(60_000)
test.use({ reducedMotion: "reduce" })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`profile shortcut ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto("/test/e2e/owner-profile-harness.html")
      await expect(page.getByText(/@.+ vamos revisar a entrega de hoje\./)).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
      const chip = page.locator(".user-chip")
      await expect(chip).toBeVisible()
      if (evidence)
        await page.screenshot({
          animations: "disabled",
          path: `${evidence}/${before ? "before" : "after"}-sidebar-${width}-${theme}.png`,
        })

      await chip.focus()
      await page.keyboard.press("Enter")

      const profile = page.getByRole("button", { name: /^Chat, perfil e atalhos/ })
      await expect(profile).toHaveAttribute("aria-expanded", before ? "false" : "true")
      await expect(page.getByRole("dialog").getByRole("tab")).toHaveCount(5)
      if (!before) {
        await expect(page.getByLabel("Nome do perfil", { exact: true })).toBeFocused()
        await expect(page.getByLabel("Nome do perfil", { exact: true })).toBeInViewport()
        const editor = page.locator(".owner-profile-settings")
        // The profile closes the section, so opening from your name shows it without the switches above.
        const lastGroup = page.locator(".settings-disclosure-content > .settings-group").last()
        await expect(lastGroup.locator(".owner-profile-settings")).toBeVisible()
        await expect(page.locator(".settings-group-card .owner-profile-settings")).toHaveCount(0)
        const rowPadding = await page
          .locator(".settings-row")
          .first()
          .evaluate((row) => getComputedStyle(row).paddingLeft)
        await expect(editor).toHaveCSS("padding-left", rowPadding)
        await expect(editor).toHaveCSS("padding-right", rowPadding)
        const titleSize = await profile.locator("strong").evaluate((title) => getComputedStyle(title).fontSize)
        await expect(page.locator(".owner-profile-heading strong")).toHaveCSS("font-size", titleSize)
      }
      if (evidence)
        await page.screenshot({
          animations: "disabled",
          path: `${evidence}/${before ? "before" : "after"}-preferences-${width}-${theme}.png`,
        })
      if (before) return

      const accessibility = await new AxeBuilder({ page }).include(".owner-profile-settings").analyze()
      expect(accessibility.violations).toEqual([])
      await page.getByLabel("Nome do perfil", { exact: true }).fill("Pessoa Teste")
      await page.getByRole("button", { name: "Salvar preferências" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
      await expect(chip).toContainText("Pessoa Teste")
      await expect(chip.locator(".person-initials")).toHaveText("PT")
      await chip.click()
      await expect(page.getByLabel("Nome do perfil", { exact: true })).toHaveValue("Pessoa Teste")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }
