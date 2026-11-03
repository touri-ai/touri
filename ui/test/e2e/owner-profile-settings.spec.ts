import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import budgets from "./ui-budget.json" with { type: "json" }

for (const width of [390, 1024, 1440]) {
  test.describe(`owner profile settings at ${width}px`, () => {
    test.use({ hasTouch: width === 390, viewport: { width, height: 900 }, reducedMotion: "reduce" })

    for (const theme of ["light", "dark"]) {
      test(`localized avatar controls fit in ${theme}`, async ({ page }, info) => {
        await page.emulateMedia({ colorScheme: theme })
        await page.goto("/test/e2e/owner-profile-harness.html")
        await expect(page.getByText(/@.+ vamos revisar a entrega de hoje\./)).toBeVisible()
        if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
        await page.locator(".user-chip").click()
        const editor = page.locator(".owner-profile-settings")
        await expect(page.getByLabel("Nome do perfil", { exact: true })).toBeFocused()
        await page.evaluate(() => document.fonts.ready)
        const directory = process.env.OWNER_SETTINGS_EVIDENCE ?? info.outputPath("evidence")
        await mkdir(directory, { recursive: true })
        if (width !== 1024)
          await page.screenshot({ path: join(directory, `profile-${width}-${theme}.png`), animations: "disabled" })
        const controls = await getVisibleControls(page.getByRole("dialog"))

        expect(controls.length, controls.join(" | ")).toBeLessThanOrEqual(budgets["app-settings"].maxControls)
        await expect(editor.locator(".person-initials")).toHaveText("PT")
        await expect(page.getByLabel("Nome do perfil", { exact: true })).toHaveAttribute("placeholder", "Pessoa Teste")
        await editor.getByText("Alterar avatar", { exact: true }).click()
        await expect(editor.locator('input[type="file"]')).toBeHidden()
        await expect(editor.getByRole("button", { name: "Escolher foto", exact: true })).toBeVisible()
        await expect(editor.getByRole("button", { name: "Remover avatar do perfil" })).toHaveCount(0)
        const targets = await editor.locator("button, summary, input:not([type=file])").evaluateAll((elements) =>
          elements
            .filter((element) => element.getBoundingClientRect().width > 0)
            .map((element) => {
              const bounds = element.getBoundingClientRect()

              return { label: element.textContent || element.id, width: bounds.width, height: bounds.height }
            }),
        )
        targets.forEach((target) => {
          expect(target.height, target.label).toBeGreaterThanOrEqual(44)
          expect(target.width, target.label).toBeGreaterThanOrEqual(44)
        })
        expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        if (width !== 1024)
          await page.screenshot({ path: join(directory, `photo-picker-${width}-${theme}.png`), animations: "disabled" })
        await page.getByLabel("Enviar foto do perfil").setInputFiles({
          name: "arquivo-de-exemplo-com-nome-longo-para-verificar-o-layout.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("arquivo de exemplo"),
        })
        await expect(editor.getByRole("alert")).toContainText("Não foi possível ler a foto")
        expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

        await editor.getByRole("button", { name: "Sortear", exact: true }).click()
        await page.getByRole("button", { name: "Salvar preferências", exact: true }).click()
        await expect(page.getByRole("dialog")).toHaveCount(0)
        if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
        await page.locator(".user-chip").click()
        await expect(page.getByLabel("Nome do perfil", { exact: true })).toBeFocused()

        const savedControls = await getVisibleControls(page.getByRole("dialog"))
        expect(savedControls.length, savedControls.join(" | ")).toBeLessThanOrEqual(budgets["app-settings"].maxControls)
        await expect(editor.getByRole("button", { name: "Remover avatar do perfil" })).toHaveCount(0)
        await editor.getByRole("button", { name: "Alterar avatar", exact: true }).click()
        await expect(editor.getByRole("button", { name: "Remover avatar do perfil" })).toBeVisible()
      })
    }
  })
}

const getVisibleControls = (dialog: Locator) =>
  dialog.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>("button, input, select, summary, [role=tab]"))
      .filter((control) => {
        if (control.matches(":disabled")) return false
        const bounds = control.getBoundingClientRect()
        const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

        return target && control.contains(target)
      })
      .map((control) => control.getAttribute("aria-label") || control.textContent || control.id),
  )
