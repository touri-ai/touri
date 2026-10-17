import { expect, test } from "@playwright/test"

const before = process.env.FOLDER_CAPTURE === "before"
test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const width of [390, 1440]) {
  test(`server folder creation and grant at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`/test/e2e/data-access-harness.html${before ? "?unavailable" : ""}`)
    await page.getByRole("button", { name: "Escolher pasta do servidor" }).click()
    await page.getByRole("button", { name: "Adicionar pasta…" }).click()
    const picker = page.getByRole("dialog", { name: "Pastas no servidor" })
    await expect(picker.getByRole("button", { name: "Usar esta pasta" })).toBeVisible()
    const create = picker.getByRole("button", { name: "Nova pasta" })
    if (before) {
      await expect(create).toBeDisabled()
      await page.screenshot({ path: `../docs/assets/folder-access/before-${width}.png`, fullPage: true })
      return
    }
    await expect(create).toBeEnabled()
    await expect(picker.getByRole("radio", { name: "Somente leitura", exact: true })).toBeEnabled()
    await page.screenshot({ path: `../docs/assets/folder-access/after-${width}.png`, fullPage: true })
    await create.click()
    await picker.getByLabel("Nome da nova pasta").fill("Relatorios")
    await picker.getByRole("button", { name: "Continuar", exact: true }).click()
    await picker.getByRole("button", { name: "Criar pasta", exact: true }).click()
    await expect(picker.getByText("/workspace/Relatorios", { exact: true })).toBeVisible()
    await picker.getByRole("button", { name: "Usar esta pasta" }).click()
    await page.getByRole("button", { name: "Salvar configurações" }).click()
    const folders = await page.evaluate(
      () =>
        (
          window as unknown as { dataAccessQa: { state: () => { bots: Array<{ name: string; folders: unknown[] }> } } }
        ).dataAccessQa
          .state()
          .bots.find((bot) => bot.name === "Dados")?.folders,
    )
    expect(folders).toContainEqual({ path: "/workspace/Relatorios", access: "read-only" })
  })
}

test("saved incompatible permissions can be removed from settings", async ({ page }) => {
  test.skip(before)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/data-access-harness.html?unavailable")
  await page.evaluate(() => {
    const state = (
      window as unknown as { dataAccessQa: { state: () => { bots: Array<{ name: string; folders: unknown[] }> } } }
    ).dataAccessQa.state()
    const bot = state.bots.find((bot) => bot.name === "Dados")
    if (bot) bot.folders = [{ path: "/workspace/Planilhas", access: "read-only" }]
  })
  await page.getByRole("button", { name: "Escolher pasta do servidor" }).click()
  const remove = page.getByRole("button", { name: "Remover permissões antigas" })
  await expect(remove).toBeVisible()
  await remove.scrollIntoViewIfNeeded()
  await page.screenshot({ path: "../docs/assets/folder-access/after-recovery.png", fullPage: true })
  await remove.click()
  await page.getByRole("button", { name: "Salvar configurações" }).click()
  await expect(remove).not.toBeVisible()
})

test("unavailable server grants offer attachment and an environment recheck", async ({ page }) => {
  test.skip(before)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/data-access-harness.html?unavailable")
  await page.getByRole("button", { name: "Escolher pasta do servidor" }).click()
  await page.getByRole("button", { name: "Adicionar pasta…" }).click()
  const picker = page.getByRole("dialog", { name: "Pastas no servidor" })
  await expect(picker.getByRole("button", { name: "Anexar arquivo", exact: true })).toBeVisible()
  const recheck = picker.getByRole("button", { name: "Verificar ambiente", exact: true })
  await expect(recheck).toBeVisible()
  await recheck.click()
  await expect(recheck).toBeEnabled()
  await expect(picker.getByRole("button", { name: "Usar esta pasta" })).toBeDisabled()
  await page.screenshot({ path: "../docs/assets/folder-access/after-unavailable-390.png", fullPage: true })
})
