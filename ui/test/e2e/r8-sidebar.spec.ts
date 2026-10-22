import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"

test.use({ channel: "chromium" })
const phase = process.env.R8_SIDEBAR_PHASE ?? "after"
const output = "../docs/qa/r8/sidebar"

for (const width of [1440, 1100]) {
  for (const theme of ["light", "dark"]) {
    test(`${phase}: sidebar ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.clock.setFixedTime(new Date("2026-10-13T15:00:00Z"))
      await page.addInitScript(
        ({ theme, phase }) => {
          localStorage.setItem("touri.appearance.v1", theme)
          if (phase === "before") localStorage.setItem("touri.sidebar.mode", "bots")
          else localStorage.removeItem("touri.sidebar.mode")
        },
        { theme, phase },
      )
      await page.goto(`/test/e2e/r8-sidebar-harness.html${phase === "after" ? "?menus" : ""}`)
      await expect(page.getByRole("textbox", { name: "Mensagem para touri-qa" })).toBeVisible()
      const sidebar = page.locator(".bot-sidebar")
      const initialMode = page.locator(`[data-sidebar-mode="${phase === "before" ? "bots" : "work"}"]`)
      if (phase === "after") await expect(page.getByRole("region", { name: "Canais" })).toBeVisible()
      await expect(initialMode).toHaveAttribute("aria-selected", "true")
      await page.evaluate(() => document.fonts.ready)
      await mkdir(output, { recursive: true })
      const panel = sidebar.locator(`#sidebar-mode-panel-${phase === "before" ? "bots" : "work"}`)
      await panel.screenshot({
        path: `${output}/${phase}-${phase === "before" ? "bots" : "work"}-${width}-${theme}.png`,
      })
      await page.getByRole("tab", { name: /^Bots/ }).click()
      if (phase === "after") {
        expect(await sidebar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
        await expect(sidebar.locator("#sidebar-mode-panel-bots .bot-status-heading")).toHaveCount(0)
        const lastBot = sidebar.locator(".bot-row-main").last()
        await lastBot.scrollIntoViewIfNeeded()
        await expect(lastBot).toBeInViewport()
        const lastRow = await lastBot.boundingBox()
        const footer = await sidebar.locator(".sidebar-footer").boundingBox()
        expect(lastRow && footer && lastRow.y + lastRow.height <= footer.y).toBeTruthy()
        expect(footer && footer.y + footer.height <= 900).toBeTruthy()
        await sidebar.locator("#sidebar-mode-panel-bots .bot-groups").evaluate((element) => {
          element.scrollTop = 0
        })
        await expect(sidebar.locator(".thread-row.selected small")).toHaveText("hoje")
        await expect(sidebar.locator(".thread-row small").nth(1)).toHaveText("ontem")
        await expect(
          sidebar
            .locator("#sidebar-mode-panel-bots .bot-entry")
            .filter({ hasText: "touri-pm" })
            .locator(".bot-preview"),
        ).toHaveText("Digitar filtro · Conferir os resultados")
        await expect(sidebar.getByRole("button", { name: "Revisar aprovação de seo" })).toBeVisible()
        await expect(sidebar.getByRole("button", { name: "Abrir falha de mobile-qa" })).toBeVisible()
      }
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: `${output}/${phase}-bots-content-${width}-${theme}.png` })
      await page.getByRole("button", { name: /^Notificações/ }).click()
      await expect(page.getByRole("region", { name: "Central de notificações" })).toBeVisible()
      await page.screenshot({ path: `${output}/${phase}-notifications-${width}-${theme}.png` })
      if (phase === "after") {
        const center = page.getByRole("region", { name: "Central de notificações" })
        await expect(center.locator(".notification-row").first()).toContainText("Checklist de publicação revisado")
        await expect(page.getByRole("button", { name: "Notificações, 2 precisam de atenção" })).toBeVisible()
        await center
          .locator(".notification-row")
          .filter({ hasText: "mobile-qa" })
          .getByRole("button", { name: /^(Ver conversa|Abrir e revisar)$/ })
          .click()
        await expect(page.getByRole("textbox", { name: "Mensagem para mobile-qa" })).toBeVisible()
        await expect(page.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
        await expect(page.locator('[data-bot-entry="sidebar-bot-1"] .bot-preview')).toHaveText(
          "Aguardando você: sua aprovação",
        )
        await expect(page.getByRole("button", { name: "Abrir falha de mobile-qa" })).toHaveCount(0)
        await page.getByRole("button", { name: "Buscar conversas", exact: true }).click()
        const search = page.getByRole("dialog", { name: "Paleta de comandos" })
        await search.getByRole("combobox").fill("page.tsx")
        await expect(search.getByText("Há 21 arquivos page.tsx para revisar.")).toBeVisible()
        await page.screenshot({ path: `${output}/after-search-${width}-${theme}.png` })
        await page.keyboard.press("Escape")
        await openGlobalPage(page, "Integrações")
        await expect(page.getByRole("heading", { name: "Integrações", exact: true })).toBeVisible()
        await page
          .locator("#sidebar-mode-panel-bots .bot-entry")
          .filter({ hasText: "touri-qa" })
          .locator(".bot-row-main")
          .click()
        await expect(page.getByRole("textbox", { name: "Mensagem para touri-qa" })).toBeVisible()
        await page.getByRole("button", { name: "Criar bot", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "Criar um bot" })).toBeVisible()
        await page.getByRole("dialog", { name: "Criar um bot" }).getByRole("button", { name: "Fechar diálogo" }).click()
        // The base panel overlays the chat toolbar at narrow widths; close it through its existing affordance.
        if (await page.getByRole("button", { name: "Fechar painel do bot" }).isVisible())
          await page.getByRole("button", { name: "Fechar painel do bot" }).click()
        if (!(await page.getByRole("button", { name: "Preview do projeto" }).isVisible()))
          await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
        await page.getByRole("button", { name: "Preview do projeto" }).click()
        await expect(page.getByRole("button", { name: "Voltar ao chat" })).toBeVisible()
        await page
          .locator("#sidebar-mode-panel-bots .bot-entry")
          .filter({ hasText: "touri-coder" })
          .locator(".bot-row-main")
          .click()
        await expect(page.getByRole("button", { name: "Voltar ao chat" })).toBeVisible()
        await expect(page.locator("#sidebar-mode-panel-bots .bot-row.selected .tb-avatar")).toHaveAttribute(
          "data-bot-id",
          "sidebar-bot-3",
        )
      }
    })
  }
}
