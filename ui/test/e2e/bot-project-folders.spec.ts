import { expect, test } from "@playwright/test"
import type { UiApi } from "../../src/api/client"
import { showBotAdvanced } from "./home-navigation"

// Use bundled Chromium even when the repository config requests system Chrome.
test.use({ channel: "" })

for (const access of ["read-only", "read-write"] as const)
  test(`VM project keeps its ${access} host folder after saving settings`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/fixtures/bot-panel.html")
    await page.evaluate(async () => {
      const { api } = (window as unknown as { botPanelQa: { api: UiApi } }).botPanelQa
      await api.request(
        "PATCH /bots/:id",
        { projectId: null, folders: [{ path: "/workspace/reference", access: "read-only" }] },
        { id: "bot-mark" },
      )
    })
    await showBotAdvanced(page)
    const settings = page.getByRole("dialog", { name: "Configurações de mark" })
    await settings.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    await settings.getByRole("tab", { name: "Projeto", exact: true }).click()
    await settings.getByRole("combobox", { name: "Projeto", exact: true }).selectOption("__add_project__")
    const project = page.getByRole("dialog", { name: "Conectar projeto", exact: true })
    await project.getByRole("button", { name: "Escolher pasta", exact: true }).click()
    const picker = page.getByRole("dialog", { name: "Pastas no servidor", exact: true })
    await expect(picker.getByRole("button", { name: "Usar esta pasta", exact: true })).toBeEnabled()
    await picker.getByText("Digitar caminho", { exact: true }).click()
    await picker.getByLabel("Caminho absoluto da pasta").fill("/workspace/project")
    await picker.getByRole("button", { name: "Abrir pasta", exact: true }).click()
    await expect(picker.getByRole("button", { name: "Usar esta pasta", exact: true })).toBeEnabled()
    await picker
      .getByRole("radio", {
        name: access === "read-only" ? "Somente leitura" : "O bot pode ler e salvar arquivos aqui",
        exact: true,
      })
      .check()
    await picker.getByRole("button", { name: "Usar esta pasta", exact: true }).click()
    await project.getByRole("button", { name: "Conectar projeto", exact: true }).click()
    await project.getByRole("button", { name: "Salvar bots", exact: true }).click()
    await project.getByRole("button", { name: "Fechar diálogo", exact: true }).click()
    await settings.getByRole("tab", { name: "Acesso", exact: true }).click()
    await expect(settings.getByLabel("Acesso à pasta /workspace/project", { exact: true })).toHaveValue(access)
    await expect(settings.getByLabel("Acesso à pasta /workspace/reference", { exact: true })).toHaveValue("read-only")
    await settings.getByRole("button", { name: "Salvar configurações", exact: true }).click()
    await expect(settings).toBeHidden()
    await showBotAdvanced(page)
    await settings.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    await settings.getByRole("tab", { name: "Acesso", exact: true }).click()
    await expect(settings.getByLabel("Acesso à pasta /workspace/project", { exact: true })).toHaveValue(access)
    await expect(settings.getByLabel("Acesso à pasta /workspace/reference", { exact: true })).toHaveValue("read-only")
    await expect(settings.getByRole("switch", { name: /Acesso a qualquer pasta/ })).not.toBeChecked()
    await expect(settings.getByText(/quando a máquina será recriada/)).toBeVisible()
  })
