import { expect, test } from "@playwright/test"

test.use({ channel: "chromium" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`bounded goal controls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

    await page.getByText("Avançado · Continuar até concluir", { exact: true }).click()
    await page
      .getByRole("textbox", { name: "O que precisa estar pronto para concluir?" })
      .fill("Tabela com três opções, preços e fontes verificadas.")
    await page.getByRole("button", { name: "Continuar até concluir", exact: true }).click()

    const panel = page.getByRole("region", { name: "Continuar até concluir" })
    await expect(panel.getByRole("status")).toHaveText("Em andamento")
    await expect(panel).toContainText("3 turnos seguintes")
    await panel.getByRole("button", { name: "Pausar", exact: true }).click()
    await expect(panel.getByRole("status")).toHaveText("Pausado")
    await panel.getByRole("button", { name: "Retomar", exact: true }).click()
    await expect(panel.getByRole("status")).toHaveText("Em andamento")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    await panel.getByRole("button", { name: "Concluir agora", exact: true }).click()
    await expect(panel.getByRole("status")).toHaveText("Concluído")
  })
}
