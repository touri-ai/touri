import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const width of [390, 1440]) {
  test(`full local access explains inactive folder limits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/data-access-harness.html?full")
    await page.getByRole("button", { name: "Escolher pasta do servidor" }).click()
    const settings = page.getByRole("dialog", { name: "Permissões do bot" })
    const guidance = settings.locator(".warning-callout").filter({ hasText: /O acesso total/ })
    await expect(guidance).toBeVisible()
    if (process.env.ACCESS_CAPTURE)
      await guidance.screenshot({
        path: `${process.env.ACCESS_CAPTURE}/${process.env.ACCESS_PHASE ?? "after"}-${width}.png`,
      })
    await expect(guidance).toContainText("qualquer pasta que a conta do sistema permita")
    await expect(guidance).toContainText("As pastas e exclusões salvas não limitam este acesso.")
    await expect(settings.getByText("Pastas salvas para modos de acesso restrito")).toBeVisible()
    await expect(settings.getByRole("combobox", { name: "Acesso à pasta /workspace/reference" })).toHaveValue(
      "read-only",
    )
    await expect(settings.getByText(/perfis de navegadores e dados do touri ficam bloqueados/)).toHaveCount(0)
    await settings.getByRole("combobox", { name: "Acesso", exact: true }).selectOption("workspace-write")
    await expect(guidance).toHaveCount(0)
    await expect(settings.getByText(/As permissões e o isolamento são aplicados pelo servidor/)).toBeVisible()
    const patches = await page.evaluate(() =>
      (window as unknown as { dataAccessQa: { calls: Array<{ route: string }> } }).dataAccessQa.calls.filter(
        (call) => call.route === "PATCH /bots/:id",
      ),
    )
    expect(patches).toEqual([])
  })
}
