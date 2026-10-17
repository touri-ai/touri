import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce", hasTouch: true })

const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (window as unknown as { dataAccessQa: { calls: Array<{ route: string; input: unknown }> } }).dataAccessQa.calls,
  )

for (const width of [390, 1440]) {
  test(`device upload and server folders stay distinct at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/data-access-harness.html")
    const card = page.getByRole("region", { name: "Conectar dados" })
    await expect(card.getByRole("button", { name: "Enviar arquivo deste dispositivo" })).toBeVisible()
    if (process.env.DATA_ACCESS_CAPTURE)
      await page.screenshot({ path: `${process.env.DATA_ACCESS_CAPTURE}/after-${width}-choices.png` })
    await card.getByRole("button", { name: "Escolher pasta do servidor" }).tap()
    const settings = page.getByRole("dialog", { name: "Permissões do bot" })
    await settings.getByRole("button", { name: "Adicionar pasta…" }).tap()
    const picker = page.getByRole("dialog", { name: "Pastas no servidor" })
    const listed = picker.getByRole("button", { name: "Planilhas", exact: true })
    await expect(listed).toBeVisible()
    await expect(picker.getByRole("radio", { name: "Somente leitura", exact: true })).toBeChecked()
    await expect(picker.getByRole("textbox", { name: "Caminho absoluto da pasta" })).not.toBeVisible()
    expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 390) {
      expect((await listed.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      // A nested settings pane must not clip the folder browser on a phone.
      expect((await picker.boundingBox())?.width).toBeGreaterThanOrEqual(width - 80)
    }
    if (process.env.DATA_ACCESS_CAPTURE)
      await page.screenshot({ path: `${process.env.DATA_ACCESS_CAPTURE}/after-${width}-folders.png` })
    await picker.getByRole("button", { name: "Cancelar", exact: true }).tap()
    expect((await calls(page)).filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
    await expect(settings.getByRole("button", { name: "Adicionar pasta…" })).toBeFocused()
    await settings.getByRole("button", { name: "Adicionar pasta…" }).tap()
    await expect(listed).toBeVisible()
    await picker.getByRole("button", { name: "Fechar diálogo" }).focus()
    await page.keyboard.press("Tab")
    await expect(picker.getByRole("button", { name: "Pasta pessoal" })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(listed).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(picker.getByText("Nenhuma subpasta aqui.")).toBeVisible()
    await expect(picker.getByRole("button", { name: "Voltar uma pasta" })).toBeFocused()
    // Navigation and a loose Enter never grant access.
    await picker.getByRole("radio", { name: "Somente leitura", exact: true }).focus()
    await page.keyboard.press("Enter")
    expect((await calls(page)).filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
    await picker.getByRole("button", { name: "Usar esta pasta" }).tap()
    await settings.getByRole("button", { name: "Salvar configurações" }).tap()
    await expect(settings).not.toBeVisible()
    const patches = (await calls(page)).filter((call) => call.route === "PATCH /bots/:id")
    expect(patches).toHaveLength(1)
    expect(patches[0]?.input).toMatchObject({ folders: [{ path: "/workspace/Planilhas", access: "read-only" }] })
    expect((await calls(page)).some((call) => call.route === "POST /threads/:id/messages")).toBe(false)
  })
}

test("unsupported server grants offer a device CSV and preserve the task draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/data-access-harness.html?unavailable")
  const draft = page.getByRole("textbox", { name: "Mensagem para Dados" })
  await draft.fill("Some os valores deste CSV.")
  await page.getByRole("button", { name: "Escolher pasta do servidor" }).tap()
  await page.getByRole("button", { name: "Adicionar pasta…" }).tap()
  const picker = page.getByRole("dialog", { name: "Pastas no servidor" })
  await expect(picker.getByRole("status")).toContainText("Seu bot continua disponível.")
  await expect(picker.getByRole("button", { name: "Usar esta pasta" })).toBeDisabled()
  const chooser = page.waitForEvent("filechooser")
  await picker.getByRole("button", { name: "Anexar arquivo", exact: true }).tap()
  await (await chooser).setFiles({
    name: "tabela.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("cadastro,valor\nregistro-a,12\nregistro-b,30"),
  })
  await expect(draft).toHaveValue("Some os valores deste CSV.")
  await expect(page.getByRole("list", { name: "Arquivos anexados" })).toContainText("tabela.csv")
  expect(
    (await calls(page)).some((call) => call.route === "PATCH /bots/:id" || call.route === "POST /threads/:id/messages"),
  ).toBe(false)
})

test("the simple catalog offers CSV before any technical prerequisites", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/data-access-harness.html")
  await page.getByRole("button", { name: "Adicionar ferramenta do catálogo" }).tap()
  await expect(
    page.getByText("A conexão direta com esta fonte ainda não está disponível. Exporte um CSV para começar."),
  ).toBeVisible()
  await expect(page.getByLabel("Transporte MCP")).not.toBeVisible()
  await expect(page.getByLabel("Argumentos MCP (lista JSON)")).not.toBeVisible()
  expect((await calls(page)).some((call) => call.route === "GET /bots/:id/mcp/prerequisites")).toBe(false)
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Anexar CSV" }).tap()
  await (await chooser).setFiles([])
  await expect(page.getByRole("textbox", { name: "Mensagem para Dados" })).toBeVisible()
  expect((await calls(page)).some((call) => call.route === "POST /threads/:id/messages")).toBe(false)
})
