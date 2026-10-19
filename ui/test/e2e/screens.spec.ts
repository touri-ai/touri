import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { openGlobalPage, showBotPanel, showBotRoutines } from "./home-navigation"

const phase = process.env.R8_PHASE ?? "after"
const qa = resolve(import.meta.dirname, "../../../docs/qa/r8/screens")
test.use({ channel: "chromium" })
test.setTimeout(90_000)

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 1100]) {
    test(`screens · ${theme} · ${width}`, async ({ page }) => {
      await mkdir(qa, { recursive: true })
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((theme) => {
        localStorage.setItem("touri.appearance.v1", theme)
        localStorage.removeItem("touri.workspace.v1")
      }, theme)
      await page.goto("/test/e2e/screens-harness.html", { waitUntil: "domcontentloaded" })
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const shot = async (view: string) => {
        if (phase === "after") {
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
        }
        await page.screenshot({
          path: `${qa}/${phase}-${view}${width === 1100 ? "-narrow" : ""}-${theme}.png`,
          animations: "disabled",
        })
      }
      await showBotRoutines(page)
      await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeVisible()
      await shot("cron")
      if (phase === "after") {
        await expect(page.getByRole("button", { name: "Rodar agora Resumo da manhã" })).toHaveText("Rodar agora")
        await expect(page.getByRole("button", { name: "Retomar Resumo da manhã" })).toHaveText("Retomar")
        await expect(page.getByText("Aguardando aprovação", { exact: true })).toBeVisible()
        if (width === 1100) {
          await page.locator(".calendar-card").scrollIntoViewIfNeeded()
          await shot("cron-calendar")
          await page.locator(".cron-screen").evaluate((element) => {
            element.scrollTop = 0
          })
        }
      }
      await openGlobalPage(page, "Integrações")
      await expect(page.getByRole("heading", { name: "Integrações", exact: true })).toBeVisible()
      await shot("integrations")
      await openGlobalPage(page, "MCP")
      await expect(page.getByText("Ferramentas do touri neste computador", { exact: false }).first()).toBeVisible()
      await shot("mcp")
      if (phase === "after") {
        await expect(page.getByRole("table", { name: "Políticas de ferramentas de arquivos" })).toBeVisible()
        await page.getByRole("combobox", { name: "Política · write_file" }).selectOption("blocked")
        await expect(page.getByRole("combobox", { name: "Política · write_file" })).toHaveValue("blocked")
      }
      await page.getByRole("button", { name: /^Bots/ }).click()
      if (await page.getByRole("button", { name: "Fechar painel do bot" }).isVisible())
        await page.getByRole("button", { name: "Fechar painel do bot" }).click()
      await showBotPanel(page)
      await page.getByRole("button", { name: "Preview do projeto" }).click()
      await shot("preview")
      await page.getByRole("button", { name: "Subir tudo", exact: true }).click()
      await expect(page.getByText("Abrir no navegador do bot")).toBeVisible()
      await expect(page.locator(".preview-process-row > i.ready")).toHaveCount(2)
      const processNotice = page.getByRole("status").filter({ hasText: "Processo pronto" })
      const approvalNotice = page.locator(".approval-notice")
      await expect(processNotice).toBeVisible()
      await expect(approvalNotice).toBeVisible()
      await expect(approvalNotice).toContainText("mark pede sua aprovação")

      await processNotice.getByRole("button", { name: "Dispensar aviso", exact: true }).click()

      await expect(processNotice).toHaveCount(0)
      await expect(approvalNotice).toBeVisible()
      await expect(approvalNotice.getByRole("button", { name: "Revisar", exact: true })).toBeVisible()
      await expect(approvalNotice.getByRole("button", { name: "Dispensar aviso", exact: true })).toBeVisible()
      await shot("preview-live")
      await page.getByRole("tab", { name: "Logs", exact: true }).click()
      await page.locator(".preview-process-row").first().click()
      await expect(page.locator(".preview-logs")).toContainText("Servidor iniciado")
      await shot("logs")
      await page.getByRole("button", { name: /Notificações/ }).click()
      await expect(page.getByRole("region", { name: "Central de notificações" })).toBeVisible()
      await shot("notifications")
      if (phase === "after") {
        const center = page.getByRole("region", { name: "Central de notificações" })
        await expect(center.getByRole("heading", { name: "Hoje" })).toBeVisible()
        await expect(center.getByRole("heading", { name: "Anteriores" })).toBeVisible()
        await expect(center.locator(".notification-row").first()).toContainText("Revisão concluída")
        await center.getByRole("button", { name: "Marcar como lida" }).first().click()
        await expect(center.getByRole("button", { name: "Marcar como lida" })).toHaveCount(1)
        await center.getByRole("button", { name: "Limpar", exact: true }).click()
        await expect(center.locator(".notification-row")).toHaveCount(0)
        await center.getByRole("button", { name: "Fechar notificações" }).click()
        await page.getByRole("button", { name: /Aprovação pendente — abrir no chat/ }).click()
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        await expect(page.locator('[data-approval-id="screens-pending"]')).toBeVisible()
      }
    })
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`screen states · ${theme}`, async ({ page }) => {
    test.skip(phase === "before", "State coverage belongs to the r8 implementation")
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript((theme) => {
      localStorage.setItem("touri.appearance.v1", theme)
      localStorage.removeItem("touri.workspace.v1")
    }, theme)
    const open = async (scenario: string, view: "mcp" | "integrations" | "logs") => {
      await page.goto(`/test/e2e/screens-harness.html?scenario=${scenario}`, { waitUntil: "domcontentloaded" })
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      if (view === "logs") {
        await showBotPanel(page)
        await page.getByRole("button", { name: "Preview do projeto" }).click()
        await page.getByRole("tab", { name: "Logs", exact: true }).click()
        await page.locator(".preview-process-row").first().click()
      } else {
        if (view === "mcp") await openGlobalPage(page, "MCP")
        else await openGlobalPage(page, "Integrações")
      }
      await page.evaluate(() => document.fonts.ready)
    }
    const shot = async (view: string) =>
      page.screenshot({ path: `${qa}/after-${view}-${theme}.png`, animations: "disabled" })
    await open("mcp-loading", "mcp")
    await expect(page.getByRole("status", { name: "Carregando" })).toBeVisible()
    await expect(page.getByText("Conectado", { exact: true })).toHaveCount(0)
    await shot("mcp-loading")
    await open("mcp-error", "mcp")
    await expect(page.getByRole("alert")).toContainText("Não foi possível carregar")
    await shot("mcp-error")
    await page.getByRole("button", { name: "Tentar novamente" }).click()
    await expect(page.getByText("Conectado", { exact: true })).toBeVisible()
    await open("connections-error", "integrations")
    await expect(page.getByRole("alert")).toContainText("Não foi possível carregar")
    await shot("integrations-error")
    await page.getByRole("button", { name: "Tentar novamente" }).click()
    await expect(page.getByRole("button", { name: "Gerenciar Arquivos locais" })).toBeVisible()
    await open("empty", "integrations")
    await expect(page.getByText("Nenhuma integração conectada")).toBeVisible()
    await shot("integrations-empty")
    await open("logs-error", "logs")
    await expect(page.getByRole("alert")).toContainText("Não foi possível carregar")
    await shot("logs-error")
    await page.getByRole("button", { name: "Tentar novamente" }).click()
    await expect(page.getByRole("log")).toContainText("Servidor iniciado")
    await page.getByRole("button", { name: "Limpar", exact: true }).click()
    await expect(page.getByText("Aguardando logs do processo")).toBeVisible()
    await shot("logs-empty")
  })
}
