import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { showBotPanel } from "./home-navigation"

test.use({ channel: "chromium" })
test.setTimeout(60_000)

const evidence = resolve(import.meta.dirname, "../../../docs/qa/r8/panel")
mkdirSync(evidence, { recursive: true })
const phase = process.env.R8_CAPTURE_PHASE === "before" ? "before" : "after"
const framebuffer = readFileSync(resolve(import.meta.dirname, "fixtures/r8-desktop.js"), "utf8")
const mockDesktop = async (page: Page) => {
  await page
    .context()
    .route("**/@novnc_novnc.js*", (route) => route.fulfill({ contentType: "text/javascript", body: framebuffer }))
  await page.context().addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      close() {}
    } as unknown as typeof WebSocket
  })
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 1100]) {
    test(`panel views · ${theme} · ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      if (phase === "after") await mockDesktop(page)
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
      await page.goto(`/test/e2e/fixtures/${phase === "before" ? "bot-panel" : "r8-panel"}.html`)
      await showBotPanel(page)
      const panel = page.getByRole("complementary", { name: "Painel de mark" })
      await expect(panel).toBeVisible()
      const shot = async (view: string) => {
        await page.screenshot({ path: `${evidence}/${phase}-${view}${width === 1100 ? "-narrow" : ""}-${theme}.png` })
      }
      await shot("details")
      await page.getByRole("tab", { name: "Biblioteca" }).click()
      await expect(panel.getByRole("button", { name: /notas.md.*KB/ })).toBeVisible()
      await shot("library")
      await panel.getByRole("button", { name: /notas.md.*KB/ }).click()
      await expect(
        panel.getByRole("heading", { name: phase === "before" ? "Workspace do bot" : "Notas da campanha" }),
      ).toBeVisible()
      await shot("file")
      await page.getByRole("tab", { name: "Computador", exact: true }).click()
      await expect(panel.getByRole("button", { name: "Ligar computador" })).toBeVisible()
      await shot("computer-stopped")
      const state = async (status: string) =>
        page.evaluate((value) => {
          const qa = window as unknown as { botPanelQa: { state: (status: string) => void } }
          qa.botPanelQa.state(value)
        }, status)
      await state("starting")
      await expect(panel.getByText("Preparando a imagem Linux…")).toBeVisible()
      await shot("computer-starting")
      await state("error")
      await expect(panel.getByRole("alert")).toBeVisible()
      await shot("computer-error")
      await state("running")
      await panel.getByRole("button", { name: "Acompanhar a tela" }).click()
      await expect(panel.getByRole("button", { name: "Terminal", exact: true })).toBeVisible()
      if (phase === "after") await expect(panel.locator('.desktop-display[data-phase="ready"]')).toBeVisible()
      await shot("desktop")
      await panel.getByRole("button", { name: "Expandir" }).click()
      await expect(page.locator(".chat-panel")).toBeHidden()
      await shot("desktop-expanded")
      if (phase === "after") {
        const size = await panel.locator(".desktop-display").boundingBox()
        expect(size?.width).toBeGreaterThan(width === 1440 ? 1000 : 700)
        expect(size?.height).toBeGreaterThan(450)
        const overflow = await panel.evaluate((element) => element.scrollWidth > element.clientWidth)
        expect(overflow).toBe(false)
        const results = await new AxeBuilder({ page }).include(".bot-panel").analyze()
        expect(results.violations.filter((item) => ["critical", "serious"].includes(item.impact ?? ""))).toEqual([])
        const popup = page.waitForEvent("popup")
        await panel.getByRole("button", { name: "Abrir em janela" }).click()
        const viewer = await popup
        await viewer.setViewportSize({ width, height: 900 })
        await expect(viewer.getByRole("heading", { name: "Computador de mark" })).toBeVisible()
        await expect(viewer.locator('.desktop-display[data-phase="ready"]')).toBeVisible()
        await viewer.screenshot({
          path: `${evidence}/after-desktop-window${width === 1100 ? "-narrow" : ""}-${theme}.png`,
        })
        await viewer.close()
      }
    })
  }
}

type PanelQa = {
  folderFailure: (failed: boolean) => void
  manyFiles: () => void
  loadingFolder: () => void
}

if (phase === "after") {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 1100]) {
      test(`library recovery, origins and connection · ${theme} · ${width}`, async ({ page }) => {
        test.setTimeout(60_000)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
        await mockDesktop(page)
        const shot = async (view: string) =>
          page.screenshot({ path: `${evidence}/after-${view}${width === 1100 ? "-narrow" : ""}-${theme}.png` })
        const fixture = "/test/e2e/fixtures/r8-panel.html"
        await page.goto(fixture)
        await showBotPanel(page)
        const panel = page.getByRole("complementary", { name: "Painel de mark" })
        await page.getByRole("tab", { name: "Biblioteca" }).click()
        await panel.getByRole("button", { name: /restrita.*Pasta/ }).click()
        await expect(panel.getByRole("alert")).toContainText("restrita")
        await expect(panel.getByRole("button", { name: /notas.md.*KB/ })).toHaveCount(0)
        await shot("library-error")
        await page.evaluate(() => (window as unknown as { botPanelQa: PanelQa }).botPanelQa.folderFailure(false))
        await panel.getByRole("button", { name: "Tentar novamente" }).click()
        await expect(panel.getByText("Esta pasta está vazia.")).toBeVisible()
        await shot("library-empty")
        await panel.getByRole("button", { name: /Pasta anterior/ }).click()
        await page.evaluate(() => (window as unknown as { botPanelQa: PanelQa }).botPanelQa.loadingFolder())
        await panel.getByRole("button", { name: /documentos.*Pasta/ }).click()
        await expect(panel.getByText("Carregando arquivos…")).toBeVisible()
        await shot("library-loading")
        await expect(panel.getByText("Esta pasta está vazia.")).toBeVisible()
        await page.evaluate(() => (window as unknown as { botPanelQa: PanelQa }).botPanelQa.manyFiles())
        await panel.getByRole("button", { name: /Pasta anterior/ }).click()
        const notes = panel.getByRole("button", { name: /notas.md.*KB/ })
        await notes.scrollIntoViewIfNeeded()
        expect(await panel.locator(".bot-panel-body").evaluate((element) => element.scrollTop)).toBeGreaterThan(300)
        await notes.click()
        await expect(panel.getByRole("heading", { name: "notas.md", exact: true })).toBeFocused()
        expect(await panel.locator(".bot-panel-body").evaluate((element) => element.scrollTop)).toBe(0)
        await expect(panel.getByRole("button", { name: "Voltar aos arquivos" })).toBeVisible()
        await shot("file-from-scrolled-list")
        await panel.locator(".bot-panel-body").evaluate((element) => {
          element.scrollTop = 400
        })
        await expect(panel.getByRole("button", { name: "Voltar aos arquivos" })).toBeInViewport()
        const download = page.waitForEvent("download")
        await panel.getByRole("button", { name: "Baixar arquivo", exact: true }).click()
        expect((await download).suggestedFilename()).toBe("notas.md")
        await page.goto(`${fixture}?local=true`)
        await showBotPanel(page)
        await page.getByRole("tab", { name: "Biblioteca" }).click()
        await expect(panel.getByRole("heading", { name: "Pasta do bot" })).toBeVisible()
        await expect(panel.getByText("/Users/demo/Library/Application Support/touri/bots/bot-mark")).toBeVisible()
        await shot("library-bot-folder")
        await page.getByRole("tab", { name: "Computador", exact: true }).click()
        await expect(panel.getByRole("status")).toHaveText(
          "Este servidor não tem uma área de trabalho para controlar. Você pode conversar e trabalhar com arquivos.",
        )
        await expect(panel.getByRole("button", { name: "Conversar", exact: true })).toBeVisible()
        await expect(panel.getByRole("button", { name: "Abrir arquivos", exact: true })).toBeVisible()
        await expect(panel.getByRole("button", { name: "Ligar computador", exact: true })).toHaveCount(0)
        await shot("computer-local")
        await page.goto(`${fixture}?local=true&project=true`)
        await showBotPanel(page)
        await page.getByRole("tab", { name: "Biblioteca" }).click()
        await expect(panel.getByText("/Users/demo/javascript/touri-demo")).toBeVisible()
        await shot("library-project")
        await page.goto(`${fixture}?empty-routines=true`)
        await showBotPanel(page)
        await expect(panel.getByText("Nenhuma rotina agendada", { exact: true })).toBeVisible()
        await shot("details-empty-routines")
        await page.goto(`${fixture}?connecting=true`)
        await showBotPanel(page)
        await page.getByRole("tab", { name: "Computador", exact: true }).click()
        await panel.getByRole("button", { name: "Ligar computador" }).click()
        await expect(panel.getByText("Conectando…", { exact: true })).toBeVisible()
        await expect(panel.getByText("Sem imagem ainda. Aguardando a primeira imagem da VM.")).toBeVisible()
        await shot("desktop-connecting")
        await panel.getByRole("button", { name: "Terminal", exact: true }).click()
        await expect(panel.getByLabel("Comando na VM")).toBeDisabled()
        await shot("terminal")
      })
    }
  }
}
