import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { test as base, expect, type Page } from "@playwright/test"
import { openGlobalPage, showBotAdvanced, showBotPanel, showBotRoutines } from "./home-navigation"

const evidence = resolve(import.meta.dirname, "../../../docs/qa/r8/integrated")
const framebuffer = readFileSync(resolve(import.meta.dirname, "fixtures/r8-desktop.js"), "utf8")
const test = base.extend<object, { preparedHarness: undefined }>({
  preparedHarness: [
    async ({ browser }, use, workerInfo) => {
      const page = await browser.newPage({ baseURL: workerInfo.project.use.baseURL })

      // Cold development-server compilation must finish before the timed screenshot cases.
      await prepare(page, "light", 1440)
      await page.close()
      await use(undefined)
    },
    { scope: "worker", auto: true },
  ],
})

const prepare = async (page: Page, theme: "light" | "dark", width: number) => {
  await mkdir(evidence, { recursive: true })
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.clock.setFixedTime(new Date("2026-10-13T18:30:00Z"))
  await page
    .context()
    .route("**/@novnc_novnc.js*", (route) => route.fulfill({ contentType: "text/javascript", body: framebuffer }))
  await page.addInitScript((theme) => {
    localStorage.setItem("touri.appearance.v1", theme)
    localStorage.removeItem("touri.workspace.v1")
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args) {
        if (String(args[0]).endsWith("/mock-desktop"))
          return new (class extends EventTarget {
            close() {}
          })()
        return Reflect.construct(Target, args)
      },
    })
  }, theme)
  await page.goto("/test/e2e/integrated-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Revisão do projeto", exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
}

for (const width of [1440, 1100]) {
  for (const theme of ["light", "dark"] as const) {
    test(`integrated screens · ${theme} · ${width}`, async ({ page }) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await prepare(page, theme, width)
      const shot = (view: string) => captureView(page, width, theme, view)
      await showBotPanel(page)
      const panel = page.getByRole("complementary", { name: "Painel de mark" })
      await expect(panel).toBeVisible()
      const chatBounds = await page.locator(".chat-panel").boundingBox()
      const panelBounds = await panel.boundingBox()
      expect(chatBounds).not.toBeNull()
      expect(panelBounds).not.toBeNull()
      expect(panelBounds?.x).toBeGreaterThanOrEqual((chatBounds?.x ?? 0) + (chatBounds?.width ?? 0) - 1)
      await expect(page.locator('[data-approval-id="screens-pending"]')).toBeVisible()
      await shot("chat-panel")
      await panel.getByRole("tab", { name: "Biblioteca" }).click()
      await expect(panel.getByRole("button", { name: /\.md/ }).first()).toBeVisible()
      await shot("library")
      await panel.getByRole("tab", { name: "Computador", exact: true }).click()
      await expect(panel.getByRole("button", { name: "Acompanhar a tela" })).toBeVisible()
      await shot("computer")
      await panel.getByRole("button", { name: "Acompanhar a tela" }).click()
      await expect(panel.locator('.desktop-display[data-phase="ready"]')).toBeVisible()
      await shot("desktop")
      await panel.getByRole("button", { name: "Expandir", exact: true }).click()
      await expect(page.locator(".chat-panel")).toBeHidden()
      const display = await panel.locator(".desktop-display").boundingBox()
      expect(display?.width).toBeGreaterThan(width - 400)
      expect(display?.height).toBeGreaterThan(450)
      await shot("desktop-expanded")
      await panel.getByRole("button", { name: "Recolher", exact: true }).click()
      await showBotRoutines(page)
      await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeVisible()
      await shot("cron")
      await openGlobalPage(page, "Integrações")
      await expect(page.getByRole("button", { name: "Gerenciar Arquivos locais" })).toBeVisible()
      await shot("integrations")
      await openGlobalPage(page, "MCP")
      await expect(page.getByRole("table", { name: "Políticas de ferramentas de arquivos" })).toBeVisible()
      await shot("mcp")
      await page.getByRole("button", { name: /^Bots/ }).click()
      if (!(await page.getByRole("button", { name: "Preview do projeto" }).isVisible()))
        await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
      await page.getByRole("button", { name: "Preview do projeto" }).click()
      await expect(page.getByRole("heading", { name: "Preview", exact: true })).toHaveCount(1)
      await shot("preview")
      await page.getByRole("tab", { name: "Logs", exact: true }).click()
      await page.locator(".preview-process-row").first().click()
      await expect(page.getByRole("log", { name: "Logs do processo" })).toContainText("Servidor iniciado")
      await shot("logs")
      await page.getByRole("button", { name: /Notificações/ }).click()
      const center = page.getByRole("region", { name: "Central de notificações" })
      await expect(center.getByRole("heading", { name: "Hoje" })).toBeVisible()
      await expect(center.getByRole("heading", { name: "Anteriores" })).toBeVisible()
      await shot("notifications")
      await center.getByRole("button", { name: "Fechar notificações" }).click()
      await page.getByRole("button", { name: "Voltar ao chat" }).click()
      expect(errors).toEqual([])
    })

    test(`integrated settings and creation · ${theme} · ${width}`, async ({ page }) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await prepare(page, theme, width)
      const shot = (view: string) => captureView(page, width, theme, view)

      await showBotAdvanced(page)
      const dialog = page.getByRole("dialog")

      await expect(dialog.getByRole("textbox", { name: "O que ele faz", exact: true })).toHaveValue(
        "Pesquisa e planejamento",
      )
      await shot("bot-settings")
      await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
      for (const [tab, view] of [
        ["Modelo", "bot-settings-model"],
        ["Acesso", "bot-settings-access"],
        ["Computador", "bot-settings-computer"],
        ["Projeto", "bot-settings-project"],
        ["Permissões", "bot-settings-permissions"],
        ["Ferramentas", "bot-settings-mcp"],
      ] as const) {
        await dialog.getByRole("tab", { name: tab, exact: true }).click()
        await shot(view ?? "settings")
        if (tab === "Ferramentas") {
          await expect(dialog.getByRole("combobox", { name: "Classificação · read_file" })).toHaveCount(0)

          await dialog.getByRole("button", { name: "Configuração técnica (MCP)", exact: true }).click()
          const classification = dialog.getByRole("combobox", { name: "Classificação · read_file", exact: true })

          await expect(classification).toHaveValue("reads")
          await expect(dialog.getByRole("combobox", { name: "Política · read_file", exact: true })).toHaveValue(
            "always_allow",
          )
          await classification.scrollIntoViewIfNeeded()
          await shot("bot-settings-mcp-policies")
        }
      }
      await dialog.getByRole("tab", { name: "Rotinas", exact: true }).click()

      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole("region", { name: "Rotinas", exact: true })).toBeFocused()
      await shot("bot-settings-routines")
      await page.getByRole("button", { name: /Você Local/ }).click()
      await expect(dialog.getByText("preferências locais", { exact: true })).toBeVisible()
      await shot("preferences")
      await dialog.getByRole("tab", { name: "Privacidade", exact: true }).click()
      await shot("preferences-privacy")
      await dialog.getByRole("button", { name: "Fechar diálogo" }).click()
      await openGlobalPage(page, "Verificar este Mac")
      await expect(dialog.getByText(/prontos.*avisos.*falhas/)).toBeVisible()
      await shot("doctor")
      await dialog.getByRole("button", { name: "Fechar diálogo" }).click()
      // Creation from a global page must end in the new bot's conversation.
      await page.getByRole("button", { name: "Criar bot", exact: true }).click()
      await page.getByLabel("Nome", { exact: true }).fill("Clara")
      await shot("new-bot-name")
      await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
      await page.getByLabel("Função", { exact: true }).fill("Pesquisa e planejamento")
      await page.getByLabel("Instruções do bot").fill("Pesquise com cuidado e apresente fontes em português.")
      await shot("new-bot-role")
      await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
      expect(errors).toEqual([])
    })
  }
}

const captureView = async (page: Page, width: number, theme: "light" | "dark", view: string): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  for (const modal of await page.getByRole("dialog").all()) {
    expect(await modal.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await expect(modal.getByRole("button", { name: "Fechar diálogo" })).toBeInViewport()
  }
  await page.screenshot({ path: `${evidence}/${view}-${width}-${theme}.png`, animations: "disabled" })
}
