import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("only a name takes two clicks from the landing to chat", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html")
  let clicks = 0
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  clicks++
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Nome", { exact: true })).toBeFocused()
  await expect(dialog).not.toContainText(/SOUL\.md|provider|provedor|model|MCP|sandbox|\bVM\b/i)
  await expect(dialog.getByRole("button", { name: "Continuar" })).toHaveCount(0)
  await page.keyboard.type("Clara")
  await expect(dialog.getByText(/Usa o Codex/)).toBeVisible()
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  clicks++
  await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(clicks).toBe(2)
})

test("a job can be searched and chosen by keyboard, with advanced edits preserved", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html")
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
  await dialog.getByRole("searchbox", { name: "Buscar trabalhos" }).fill("codigo")
  await expect(dialog.getByRole("radio")).toHaveCount(6)
  await dialog.getByRole("radio", { name: "Ainda não sei" }).focus()
  await page.keyboard.press("ArrowDown")
  await expect(dialog.getByRole("radio", { name: "Mapa do repositório" })).toBeChecked()
  await expect(dialog.getByRole("radio", { name: "Mapa do repositório" })).toBeFocused()
  await dialog.getByRole("button", { name: "Avançado" }).click()
  await expect(dialog.getByLabel("Função", { exact: true })).toHaveValue(/estrutura/)
  await expect(dialog.getByLabel("Instruções do bot", { exact: true })).toHaveValue(
    /Peça permissão antes de mudar arquivos/,
  )
  await dialog.getByLabel("Modelo", { exact: true }).fill("custom-model")
  await dialog.getByRole("button", { name: "Avançado" }).click()
  await dialog.getByRole("button", { name: "Avançado" }).click()
  await expect(dialog.getByLabel("Modelo", { exact: true })).toHaveValue("custom-model")
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  await expect(page.locator(".bot-entry").filter({ hasText: "Clara" }).locator(".bot-role")).toContainText("estrutura")
})

test("a missing account is explained inline and creating succeeds after sign-in", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html?signed-out")
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("region", { name: "Escolha uma conta" })).toBeVisible()
  await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("Entre em uma conta acima")
  await expect(dialog.getByRole("alert")).toBeInViewport()
  await expect(dialog.getByRole("region", { name: "Escolha uma conta" })).toBeFocused()
  await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("Clara")
  await dialog.getByRole("button", { name: "Claude Code", exact: true }).click()
  await dialog.getByRole("button", { name: "Usar outra conta", exact: true }).click()
  await expect(dialog.getByText(/Usa o Claude Code/)).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
})

test("create and advanced have no serious accessibility violations and restore focus", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html")
  const trigger = page.getByRole("button", { name: "Criar meu primeiro bot" })
  await trigger.click()
  for (const advanced of [false, true]) {
    if (advanced) await page.getByRole("button", { name: "Avançado" }).click()
    const result = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
      [],
    )
  }
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
