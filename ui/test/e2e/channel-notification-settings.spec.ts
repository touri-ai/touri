import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

for (const colorScheme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`notification sound settings in ${colorScheme} at ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), colorScheme)
      await page.goto("/test/e2e/home-harness.html")
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await page.getByRole("button", { name: "Você", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Configurações", exact: true })
      await dialog.getByRole("tab", { name: "Notificações", exact: true }).click()
      await dialog.getByText("Escolher avisos e horário silencioso", { exact: true }).click()
      await dialog.getByText("Som para cada resposta", { exact: true }).scrollIntoViewIfNeeded()
      const sound = dialog.getByRole("switch", {
        name: "Tocar um som quando um bot terminar algo num canal fora da tela",
        exact: true,
      })
      await expect(sound).toBeChecked()
      const audit = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(audit.violations).toEqual([])
      expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const name = `notification-settings-${colorScheme}-${width}.png`
      const bytes = await page.screenshot({ animations: "disabled" })
      await writeFile(info.outputPath(name), bytes)
      const directory = process.env.TOURI_SCREENSHOT_DIR
      if (directory) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, name), bytes)
      }

      await sound.uncheck()
      await dialog.getByRole("button", { name: "Salvar preferências", exact: true }).click()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await page.getByRole("button", { name: "Você", exact: true }).click()
      await dialog.getByRole("tab", { name: "Notificações", exact: true }).click()
      await dialog.getByText("Escolher avisos e horário silencioso", { exact: true }).click()

      await expect(sound).not.toBeChecked()
    })
  }
}
