import { expect, test } from "@playwright/test"

// Clear the shared Chrome channel so this flow uses Playwright's bundled Chromium.
test.use({ channel: "", headless: true, viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })

test.beforeEach(async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html?host=mac")
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  await page.getByLabel("Nome", { exact: true }).fill("Pesquisa")
  await expect(page.getByText(/Usa o Codex/)).toBeVisible()
})

test("creation shows its access boundary before opening Advanced", async ({ page }) => {
  await expect(page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  await expect(
    page.getByText(
      "Pede permissão antes de mudar arquivos; alterações ficam na pasta do bot, no projeto e nas pastas liberadas.",
    ),
  ).toBeVisible()
})

test("read-only access remains visible after closing Advanced", async ({ page }) => {
  await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await page.getByLabel("Acesso", { exact: true }).selectOption("read-only")
  await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await expect(page.getByText("Somente leitura; pode ler arquivos no Mac, sem alterá-los.")).toBeVisible()
})

test("switching approved full access to Codex describes the saved approval mode", async ({ page }) => {
  await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await page.getByLabel("Provedor", { exact: true }).selectOption("claude")
  await page.getByLabel("Acesso", { exact: true }).selectOption("full-approved")
  await expect(page.getByText(/^Acesso total com aprovação;/)).toBeVisible()
  await page.getByLabel("Provedor", { exact: true }).selectOption("codex")
  await expect(page.getByLabel("Acesso", { exact: true })).toHaveValue("full")
  await expect(page.getByText(/^Acesso total com aprovação;/)).toHaveCount(0)
  await expect(page.getByText(/^Acesso total;/)).toBeVisible()
  await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await page.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Pesquisa" })).toBeVisible()
  const policy = await page.evaluate(() => {
    const api = (
      window as unknown as {
        createBotApi: { getState: () => { bots: Array<{ provider: string; access: string; approvals: string }> } }
      }
    ).createBotApi
    const bot = api.getState().bots[0]
    return { provider: bot?.provider, access: bot?.access, approvals: bot?.approvals }
  })
  expect(policy).toEqual({ provider: "codex", access: "full", approvals: "never" })
})
