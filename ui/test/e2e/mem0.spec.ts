import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1100, height: 1000 }, reducedMotion: "reduce" })

for (const theme of ["light", "dark"]) {
  test(`optional memory settings preserve consent and explain pending changes (${theme})`, async ({ page }, info) => {
    await page.goto(`/test/e2e/mem0-harness.html?theme=${theme}`)
    const card = page.getByRole("article", { name: "Memória Mem0" })
    await expect(card.getByRole("switch", { name: "Ativar Mem0 para este bot" })).not.toBeChecked()
    await card.getByLabel("Onde ficam as memórias").selectOption("server")
    await card.getByLabel("URL do servidor").fill("http://localhost:8888")
    await card.getByLabel("Chave da API").fill("synthetic-memory-key")
    await expect(card.getByRole("button", { name: "Testar conexão" })).toBeDisabled()
    await expect(card.getByText("Salve as alterações antes de testar a conexão.")).toBeVisible()
    await expect(card.getByText(/vai para o seu servidor Mem0/)).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await page.evaluate(() => document.fonts.ready)
    expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const directory = resolve(import.meta.dirname, "../../../docs/evidence/issue-283")
    mkdirSync(directory, { recursive: true })
    const path = `${directory}/memory-${theme}.png`
    await card.screenshot({ path, animations: "disabled" })
    await info.attach("Optional memory settings", { path, contentType: "image/png" })
    await card.getByRole("button", { name: "Salvar Mem0" }).click()
    await expect(card.getByText("Salvo.", { exact: true })).toBeVisible()
    await expect(card.getByLabel("Chave da API")).toHaveValue("")
    await card.getByRole("button", { name: "Testar conexão" }).click()
    await expect(card.getByText("Conexão funcionando.")).toBeVisible()
    await expect(card.getByRole("switch", { name: "Ativar Mem0 para este bot" })).not.toBeChecked()
  })
}
