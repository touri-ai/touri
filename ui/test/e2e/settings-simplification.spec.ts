import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { showBotAdvanced } from "./home-navigation"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

const nativePreferencesTabs = [
  "Modelos por API",
  "Aparência",
  "Privacidade",
  "Atualizações",
  "Notificações",
  "Diagnóstico",
  "Avançado",
]

test("bot identity stays simple and every advanced section remains reachable", async ({ page }) => {
  await page.goto("/test/e2e/r8-settings-harness.html")
  const trigger = page.getByRole("button", { name: "Ações de mark", exact: true })
  await showBotAdvanced(page)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("textbox", { name: "Nome", exact: true })).toBeFocused()
  await expect(dialog.getByRole("textbox", { name: "O que ele faz" })).toBeVisible()
  await expect(dialog.getByRole("group", { name: "Mascote", exact: true })).toBeVisible()
  await expect(dialog.getByRole("tablist")).toHaveCount(0)
  await expect(dialog.locator(".bot-settings-overview")).toContainText("Pede permissão antes de mudar arquivos;")
  const simple = await new AxeBuilder({ page }).include(".modal-card").analyze()
  expect(simple.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([])
  await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await expect(dialog.getByRole("tab")).toHaveText([
    "Modelo",
    "Acesso",
    "Computador",
    "Projeto",
    "Ferramentas",
    "Permissões",
    "Rotinas",
  ])
  for (const section of ["Modelo", "Acesso", "Computador", "Projeto", "Ferramentas", "Permissões"]) {
    await dialog.getByRole("tab", { name: section, exact: true }).click()
    await expect(dialog.getByRole("tabpanel", { name: section, exact: true })).toBeVisible()
  }
  await dialog.getByRole("tab", { name: "Acesso", exact: true }).click()
  await expect(dialog.getByRole("combobox", { name: "Acesso", exact: true })).toHaveValue("workspace-write")
  await expect(dialog.getByRole("tabpanel", { name: "Acesso", exact: true })).toContainText(
    "Pede permissão antes de mudar arquivos;",
  )
  const advanced = await new AxeBuilder({ page }).include(".modal-card").analyze()
  expect(advanced.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
    [],
  )
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await showBotAdvanced(page)
  await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await dialog.getByRole("tab", { name: "Rotinas", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Rotinas", exact: true })).toBeFocused()
})

test("native preferences list the core tabs and advanced server settings", async ({ page }) => {
  await page.goto("/test/e2e/r8-settings-harness.html")
  await page.getByRole("button", { name: /Você Local/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("tab")).toHaveText(nativePreferencesTabs)

  await dialog.getByRole("tab", { name: "Modelos por API", exact: true }).click()
  await expect(dialog.getByLabel("Provedor da API")).toBeVisible()
  await expect(dialog.getByLabel("Chave de API", { exact: true })).toHaveAttribute("type", "password")
  await dialog.getByRole("tab", { name: "Avançado", exact: true }).click()
  await expect(dialog.getByRole("region", { name: "Usar um servidor touri", exact: true })).toBeVisible()
  await expect(dialog.getByLabel("Endereço do servidor", { exact: true })).toBeVisible()
})

test("app preferences disclose technical controls and preserve edits between sections", async ({ page }) => {
  await page.goto("/test/e2e/r8-settings-harness.html")
  await page.getByRole("button", { name: /Você Local/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("tab")).toHaveText(nativePreferencesTabs)
  await expect(dialog.getByRole("switch")).toHaveCount(0)
  await dialog.getByRole("combobox", { name: "Tema", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(dialog.locator("summary").first()).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused()
  const appearance = await new AxeBuilder({ page }).include(".modal-card").analyze()
  expect(appearance.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
    [],
  )
  await dialog.getByText("Chat, barra lateral e atalhos", { exact: true }).click()
  await dialog.getByRole("switch", { name: "Mover bots com novidades para o topo", exact: true }).uncheck()
  await dialog.getByRole("tab", { name: "Privacidade", exact: true }).click()
  await expect(dialog.getByRole("spinbutton")).toHaveCount(0)
  await dialog.getByText("Dados, permissões e conexões", { exact: true }).click()
  await expect(dialog.getByRole("spinbutton", { name: "Retenção dos detalhes", exact: true })).toBeVisible()
  await dialog.getByRole("tab", { name: "Diagnóstico", exact: true }).click()
  await expect(dialog.getByRole("region", { name: "Armazenamento" })).toHaveCount(0)
  await dialog.getByText("Verificar e cuidar deste computador", { exact: true }).click()
  await expect(dialog.getByRole("region", { name: "Armazenamento" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Verificar novamente" })).toBeVisible()
  await dialog.getByText("Reportar problema", { exact: true }).click()
  await expect(dialog.getByLabel("Título", { exact: true })).toBeVisible()
  await dialog.getByRole("tab", { name: "Aparência", exact: true }).click()
  await dialog.getByText("Chat, barra lateral e atalhos", { exact: true }).click()
  await expect(
    dialog.getByRole("switch", { name: "Mover bots com novidades para o topo", exact: true }),
  ).not.toBeChecked()
  await dialog.getByRole("button", { name: "Salvar preferências", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole("button", { name: /Você Local/ }).click()
  await dialog.getByText("Chat, barra lateral e atalhos", { exact: true }).click()
  await expect(
    dialog.getByRole("switch", { name: "Mover bots com novidades para o topo", exact: true }),
  ).not.toBeChecked()
})
