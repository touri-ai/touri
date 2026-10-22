import { mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { showBotPanel } from "./home-navigation"

const frame = readFileSync(resolve(import.meta.dirname, "fixtures/qa-r4-desktop.js"), "utf8")
const evidence = resolve(import.meta.dirname, "../../../docs/evidence/qa-r4")
const mockFrames = async (page: Page) => {
  await page.route("**/@novnc_novnc.js*", (route) => route.fulfill({ contentType: "text/javascript", body: frame }))
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      close() {}
    } as unknown as typeof WebSocket
    localStorage.removeItem("touri.workspace.v1")
  })
}
const setFrame = (page: Page, state: string) =>
  page.evaluate((state) => Object.assign(window, { qaVmFrame: state }), state)
const openComputer = async (page: Page) => {
  await showBotPanel(page)
  await page.getByRole("tab", { name: "Computador", exact: true }).click()
  await page.getByRole("button", { name: "Acompanhar a tela", exact: true }).click()
  await expect(page.locator(".desktop-canvas canvas")).toBeVisible()
}
const shot = async (page: Page, name: string) => {
  mkdirSync(evidence, { recursive: true })
  const subject = name.startsWith("draft-")
    ? page.locator(".composer")
    : name === "browser-consent"
      ? page.locator('[data-setting-id="browserEnabled"]')
      : name === "browser-disabled"
        ? page.locator(".bot-computer")
        : name === "attention-resolved"
          ? page.getByRole("region", { name: "Central de notificações" })
          : page.locator(".desktop-panel")
  await subject.screenshot({ path: resolve(evidence, `${name}.png`), animations: "disabled" })
}

test("login draft survives a fresh browser context and is cleared after sending", async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto("/test/e2e/qa-r4-harness.html?scenario=login")
  const input = page.getByRole("textbox", { name: "Mensagem para mark" })
  await input.fill("Oi! Em uma linha, o que você faz?")
  await shot(page, "draft-saved")
  const state = await context.storageState()
  await context.close()
  const reopened = await browser.newContext({ storageState: state })
  const next = await reopened.newPage()
  await next.goto("/test/e2e/qa-r4-harness.html?scenario=login")
  await expect(next.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(
    "Oi! Em uma linha, o que você faz?",
  )
  await shot(next, "draft-restored")
  await next.goto("/test/e2e/qa-r4-harness.html")
  await next.getByRole("textbox", { name: "Mensagem para mark" }).press("Enter")
  await expect(next.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("")
  await next.reload()
  await expect(next.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("")
  await reopened.close()
})

test("disabled browser opens the exact setting and waits for explicit consent", async ({ page }) => {
  await mockFrames(page)
  await page.goto("/test/e2e/qa-r4-harness.html?scenario=disabled")
  await showBotPanel(page)
  await page.getByRole("tab", { name: "Computador", exact: true }).click()
  await expect(page.getByText("O navegador deste bot está desativado.")).toBeVisible()
  await shot(page, "browser-disabled")
  await page.getByRole("button", { name: "Ativar navegador", exact: true }).click()
  const toggle = page.locator("#settings-browser")
  await expect(toggle).toBeFocused()
  await expect(toggle).not.toBeChecked()
  await shot(page, "browser-consent")
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.getByRole("button", { name: "Cancelar", exact: true }).click()
  await page.getByRole("button", { name: "Acompanhar a tela", exact: true }).click()
  await expect(page.getByText("Navegador ainda não aberto")).toBeVisible()
})

test("takeover waits for a frame and reconnection gives bounded feedback", async ({ page }) => {
  test.setTimeout(40_000)
  await mockFrames(page)
  await page.goto("/test/e2e/qa-r4-harness.html")
  await openComputer(page)
  await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled()
  await setFrame(page, "none")
  await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
  await expect(
    page.getByText("O bot está aguardando. O controle ficará disponível quando a imagem chegar."),
  ).toBeVisible()
  await expect(page.getByText("Você está no controle", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Digitar na VM")).toBeDisabled()
  await shot(page, "takeover-awaiting-frame")
  await setFrame(page, "page")
  await expect(page.getByText("Você está no controle", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Digitar na VM")).toBeEnabled()
  await setFrame(page, "none")
  await page.getByRole("button", { name: "Reconectar tela", exact: true }).click()
  await expect(page.getByRole("button", { name: "Reconectando tela…" })).toBeVisible()
  await expect(page.getByLabel("Digitar na VM")).toBeDisabled()
  await expect(page.getByText("Você está no controle", { exact: true })).toHaveCount(0)
  await expect(
    page.getByText("A tela da VM conectou, mas não enviou nenhuma imagem. Tente reconectar a tela."),
  ).toBeVisible({ timeout: 12_000 })
  await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
  await setFrame(page, "page")
  await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled()
  await shot(page, "reconnected-observation")
})

test("a newer successful run leaves the old failure as resolved bell history", async ({ page }) => {
  await page.goto("/test/e2e/qa-r4-harness.html?scenario=attention")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await expect(page.getByText("Aguardando você: revise a tarefa interrompida")).toHaveCount(0)
  await page.getByRole("button", { name: /Notificações/ }).click()
  const center = page.getByRole("region", { name: "Central de notificações" })
  await expect(center.locator(".notification-row.resolved")).toHaveCount(1)
  await expect(center.getByText("Interrupção anterior · resolvida", { exact: true })).toBeVisible()
  await shot(page, "attention-resolved")
  await page.reload()
  await expect(page.getByText("Aguardando você: revise a tarefa interrompida")).toHaveCount(0)
})

test("the separate computer window opens browser settings without enabling them", async ({ page }) => {
  await mockFrames(page)
  await page.goto("/test/e2e/qa-r4-harness.html?scenario=disabled&computer=bot-mark")
  await page.getByRole("button", { name: "Ativar navegador", exact: true }).click()
  await expect(page.locator("#settings-browser")).toBeFocused()
  await expect(page.locator("#settings-browser")).not.toBeChecked()
  await page.getByRole("tab", { name: "Rotinas", exact: true }).click()
  await expect(page.getByRole("tabpanel", { name: "Rotinas", exact: true })).toBeVisible()
})
