import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test("API models: configure, test, select for a bot and delete a key", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto("/test/e2e/api-models-harness.html")
  await page.getByLabel("Provedor da API").selectOption("deepseek")
  await page.getByLabel("Chave de API").fill("fixture-api-key-for-demo")
  await expect(page.getByLabel("Chave de API")).toHaveAttribute("type", "password")
  await page.getByRole("button", { name: "Carregar modelos" }).click()
  await expect(page.getByRole("status")).toHaveText("Escolha um modelo da lista ou digite o identificador.")
  await page.getByLabel("Identificador do modelo").fill("demo-model")
  await page.getByLabel("Nome (opcional)").fill("Pesquisa")
  await page.getByRole("button", { name: "Testar conexão", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Conexão confirmada. O modelo está pronto para usar.")
  const shots = process.env.TOURI_BYOK_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, "api-model-add.png") })
  }
  await page.getByRole("button", { name: "Salvar modelo por API" }).click()
  await expect(page.getByText("Chave guardada no cofre · ••••••••")).toBeVisible()
  await expect(page.getByLabel("Chave de API")).toHaveValue("")
  await page.getByRole("heading", { name: "Modelos por API", exact: true }).scrollIntoViewIfNeeded()
  if (shots) await page.screenshot({ path: join(shots, "api-model-saved.png") })
  await page.getByRole("button", { name: "Testar conexão com Pesquisa" }).click()
  await expect(page.getByRole("status")).toHaveText("Conexão confirmada. O modelo está pronto para usar.")
  await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()
  await page.getByRole("button", { name: "Criar bot com API" }).click()
  const picker = page.getByLabel("Modelos por API", { exact: true })
  await picker.selectOption({ label: "Pesquisa · demo-model" })
  await page.getByLabel("Nome", { exact: true }).fill("Pesquisa")
  await expect(page.getByText("Entre em uma conta para criar seu bot.")).toHaveCount(0)
  if (shots) await page.screenshot({ path: join(shots, "api-model-bot.png") })
  await page.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByText("Bot de demonstração criado.")).toBeVisible()
  await page.getByRole("button", { name: "Configurar modelos" }).click()
  await page.getByRole("button", { name: "Remover Pesquisa" }).click()
  await expect(page.getByText("Modelo por API e chave removidos.")).toBeVisible()
  await expect(page.getByText("Chave guardada no cofre · ••••••••")).toHaveCount(0)
})
