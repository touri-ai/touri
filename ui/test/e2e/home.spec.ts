import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { openGlobalPage, showBotAdvanced, showBotRoutines } from "./home-navigation"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("workspace loads history on selection and keeps background activity", async ({ page }) => {
  await page.goto("/test/e2e/home-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  const histories = () =>
    page.evaluate(() => {
      const api = (
        window as unknown as { workspaceQa: { api: { calls: { route: string; pathValues: { id?: string } }[] } } }
      ).workspaceQa.api
      return api.calls.filter((call) => call.route === "GET /threads/:id/messages").map((call) => call.pathValues.id)
    })
  await expect.poll(histories).toEqual(["thread-mark"])
  const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
  await expect(sidebar.locator('[data-bot-entry="bot-onb"]')).toHaveAttribute("data-activity", "working")
  await sidebar.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
  await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
  await expect.poll(histories).toEqual(["thread-mark", "thread-onb"])
})

test("Home keeps advanced pages behind a single door and groups bots by their work", async ({ page }) => {
  await page.goto("/test/e2e/home-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
  await expect(sidebar.locator(".bot-status-heading")).toHaveText(["Precisa de você", "Trabalhando", "Ociosos"])
  await expect(sidebar.locator('[data-bot-entry="bot-mark"] .bot-preview')).toHaveText("Aguardando você: sua resposta")
  await expect(sidebar.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
  await expect(page.locator(".bot-panel")).toHaveCount(0)
  for (const name of ["MCP", "Integrações", "Projetos", "Importar", "Rotinas"])
    await expect(sidebar.getByRole("button", { name, exact: true })).toHaveCount(0)
  await openGlobalPage(page, "MCP")
  await expect(page.getByRole("heading", { name: "MCP", exact: true })).toBeVisible()
  await openGlobalPage(page, "Integrações")
  await expect(page.getByRole("heading", { name: "Integrações", exact: true })).toBeVisible()
  await openGlobalPage(page, "Projetos")
  await expect(page.getByRole("dialog", { name: "Conectar projeto" })).toBeVisible()
  await page.getByRole("button", { name: "Fechar diálogo" }).click()
  await expect(sidebar.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })).toBeFocused()
  await openGlobalPage(page, "Verificar este Mac")
  await expect(page.getByRole("dialog", { name: "Diagnóstico" })).toBeVisible()
  await page.getByRole("button", { name: "Fechar diálogo" }).click()
  await openGlobalPage(page, "Importar")
  await expect(page.getByRole("dialog", { name: "Importar seus bots" })).toBeVisible()
  await page.getByRole("button", { name: "Fechar diálogo" }).click()
  await sidebar.getByRole("button", { name: /^Bots/ }).click()
  await page.keyboard.press("Meta+k")
  await expect(page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })).toBeFocused()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Meta+n")
  await expect(page.getByRole("dialog", { name: "Criar um bot" })).toBeVisible()
})

test("bot actions support keyboard access and routines keep their bot filter after reload", async ({ page }) => {
  await page.goto("/test/e2e/home-harness.html")
  const trigger = page.getByRole("button", { name: "Ações de mark", exact: true })
  await trigger.focus()
  await trigger.press("ArrowDown")
  await expect(page.getByRole("menuitem", { name: "Avançado" })).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("menuitem", { name: "Rotinas" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  await showBotRoutines(page)
  await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeVisible()
  const filter = page
    .getByRole("group", { name: "Filtros de rotinas" })
    .getByRole("button", { name: "mark", exact: true })
  await expect(filter).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(filter).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: /^Bots/ }).click()
  await showBotAdvanced(page)
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await settings.getByRole("tab", { name: "Rotinas", exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Rotinas", exact: true })).toBeFocused()
  await expect(filter).toHaveAttribute("aria-pressed", "true")
})

test("first run has one primary action, secondary links and no diagnostic counts", async ({ page }) => {
  await page.goto("/test/e2e/home-harness.html?scenario=empty")
  await expect(page.getByRole("heading", { name: "touri" })).toBeVisible()
  await expect(page.locator(".onboarding-actions button")).toHaveText(["Criar meu primeiro bot→"])
  await expect(page.getByRole("main")).toContainText(
    "O histórico fica neste servidor. Sua IA recebe o conteúdo necessário para responder. O touri não coleta telemetria.",
  )
  await expect(page.getByRole("main")).not.toContainText(/Prontas|Avisos|Falhas|\d/)
  await page.getByRole("button", { name: "Verificar este servidor", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Diagnóstico" })).toBeVisible()
  await page.getByRole("button", { name: "Fechar diálogo" }).click()
  await page.getByRole("button", { name: "Importar", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Importar seus bots" })).toBeVisible()
  await page.getByRole("button", { name: "Fechar diálogo" }).click()
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  await expect(page.getByRole("dialog", { name: "Criar um bot" })).toBeVisible()
  await expect(page.getByLabel("Nome", { exact: true })).toBeFocused()
})

for (const scenario of ["", "?scenario=empty"]) {
  test(`Home and Advanced remain accessible ${scenario}`, async ({ page }) => {
    await page.goto(`/test/e2e/home-harness.html${scenario}`)
    await expect(page.getByRole("main")).toBeVisible()
    await expect(page.locator(scenario ? ".onboarding-card" : ".composer")).toBeVisible()
    if (!scenario) await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([])
  })
}

for (const [legacy, heading] of [
  ["cron", "Rotinas"],
  ["integracoes", "Integrações"],
  ["mcp", "MCP"],
] as const) {
  test(`restores the saved ${legacy} destination`, async ({ page }) => {
    await page.addInitScript((page) => {
      localStorage.setItem("touri.workspace.v1", JSON.stringify({ route: { section: "touri", page } }))
    }, legacy)
    await page.goto("/")
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
  })
}
