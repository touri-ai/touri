import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { showBotAdvanced, showBotRoutines } from "./home-navigation"

test.use({ channel: "chromium" })
test.setTimeout(90_000)

for (const width of [1440, 390]) {
  test(`delete a routine from all three places with keyboard confirmation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("touri.appearance.v1", theme),
      process.env.ROUTINE_QA_THEME ?? "dark",
    )
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/home-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await showBotRoutines(page)
    const trigger = page.getByRole("button", { name: "Excluir rotina", exact: true })
    await expect(trigger).toBeVisible()
    await expect(trigger).toBeInViewport()
    expect(
      await page.locator(".routine-item").evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1)
    expect((await page.locator(".routine-copy").boundingBox())?.width).toBeGreaterThan(180)
    await page.screenshot({ path: testInfo.outputPath("card.png"), animations: "disabled" })
    await trigger.focus()
    await trigger.press("Enter")
    const confirmation = page.getByRole("alertdialog")
    await expect(confirmation).toHaveAccessibleName("Excluir a rotina Daily brief?")
    await expect(confirmation).toHaveAccessibleDescription(
      "Ela não vai mais rodar. O histórico de execuções continua nas conversas.",
    )
    const cancel = confirmation.getByRole("button", { name: "Cancelar", exact: true })
    const remove = confirmation.getByRole("button", { name: "Excluir", exact: true })
    await expect(cancel).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(remove).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(confirmation.getByRole("button", { name: "Fechar diálogo" })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(remove).toBeFocused()
    expect((await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze()).violations).toEqual([])
    expect(await confirmation.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath("confirmation.png"), animations: "disabled" })
    await page.keyboard.press("Escape")
    await expect(confirmation).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(trigger).toBeVisible()
    await trigger.click()
    await page.getByRole("button", { name: "Excluir", exact: true }).press("Space")
    await expect(confirmation).toHaveCount(0)
    await expect(trigger).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeFocused()
    await expect(page.getByText("Sua primeira rotina começa aqui")).toBeVisible()

    // Start again with a fresh fixture and delete from the editor.
    await page.reload()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await showBotRoutines(page)
    await page.getByRole("button", { name: "Editar Daily brief", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "Quando?" })
    await editor.getByRole("button", { name: "Excluir rotina", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath("editor.png"), animations: "disabled" })
    await editor.getByRole("button", { name: "Excluir rotina", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(editor).toBeVisible()
    await expect(editor.getByRole("button", { name: "Excluir rotina", exact: true })).toBeFocused()
    await editor.getByRole("button", { name: "Excluir rotina", exact: true }).click()
    await page.getByRole("button", { name: "Excluir", exact: true }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeFocused()
    await expect(page.getByText("Sua primeira rotina começa aqui")).toBeVisible()

    // The bot's routines tab opens the filtered list and its accessible confirmation.
    await page.reload()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await showBotAdvanced(page)
    const settings = page.getByRole("dialog")
    await settings.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    await settings.getByRole("tab", { name: "Rotinas", exact: true }).click()
    await expect(settings).toHaveCount(0)
    const routines = page.getByRole("region", { name: "Rotinas", exact: true })
    await expect(routines).toBeFocused()
    await trigger.scrollIntoViewIfNeeded()
    expect(
      await routines.locator(".routine-item").evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1)
    expect(await routines.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath("bot-routines.png"), animations: "disabled" })
    await trigger.click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Excluir", exact: true }).click()
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect(settings).toHaveCount(0)
    await expect(routines.getByRole("heading", { name: "Rotinas", exact: true })).toBeFocused()
    await expect(trigger).toHaveCount(0)
    if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await page.getByRole("button", { name: /^Bots/ }).click()
    await expect(page.getByText("Review the campaign", { exact: true }).first()).toBeVisible()
  })
}
