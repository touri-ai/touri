import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { chooseBotAction, openConversations } from "./home-navigation"

test.use({ channel: "chromium" })
test.describe.configure({ timeout: 90_000 })

const evidenceDirectory = process.env.TOURI_THREAD_EVIDENCE_DIR ?? join(tmpdir(), "touri-thread-delete-evidence")

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`conversation actions confirm deletion at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
      await page.addInitScript((preference) => localStorage.setItem("touri.appearance.v1", preference), theme)
      await page.clock.install({ time: new Date("2026-10-20T12:00:00Z") })
      await page.goto("/test/e2e/thread-deletion-harness.html")
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
      const conversations = await openConversations(page)
      const row = conversations.locator(".thread-row").filter({ hasText: "Eventos de leads" })
      const getEvidenceTarget = (name: string) => {
        if (name === "after-confirmation") return page.getByRole("alertdialog")
        if (name === "after-menu") return page.getByRole("menu")
        if (name === "after-undo-toast") return page.locator(".thread-delete-toast")
        return page.locator("nav.bot-sidebar")
      }
      const screenshot = (name: string) =>
        getEvidenceTarget(name).screenshot({ path: join(evidenceDirectory, `${name}-${width}-${theme}.png`) })
      await mkdir(evidenceDirectory, { recursive: true })
      await expect(row).toBeVisible()
      await screenshot("before")
      const shell = row.locator("xpath=..")
      const menuButton = shell.getByRole("button", { name: "Ações da conversa", exact: true })
      await expect(menuButton).toHaveAttribute(
        "aria-describedby",
        (await row.locator("strong").getAttribute("id")) ?? "",
      )
      const target = await menuButton.boundingBox()
      const minimumTarget = width <= 800 ? 44 : 40
      expect(target?.width).toBeGreaterThanOrEqual(minimumTarget)
      expect(target?.height).toBeGreaterThanOrEqual(minimumTarget)
      await menuButton.focus()
      await page.keyboard.press("ArrowDown")
      await expect(page.getByRole("menuitem", { name: "Arquivar conversa" })).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(menuButton).toBeFocused()
      await menuButton.click()
      await screenshot("after-menu")
      const menuA11y = await new AxeBuilder({ page })
        .include(".bot-context-menu")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
      expect(menuA11y.violations).toEqual([])
      await page.getByRole("menuitem", { name: "Apagar conversa…" }).click()
      const confirmation = page.getByRole("alertdialog", { name: "Apagar “Eventos de leads”?" })
      await expect(confirmation).toContainText("1 mensagem")
      await expect(confirmation.getByRole("button", { name: "Cancelar" })).toBeFocused()
      await screenshot("after-confirmation")
      const dialogA11y = await new AxeBuilder({ page })
        .include(".delete-thread-dialog")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
      expect(dialogA11y.violations).toEqual([])
      // Accessibility checks schedule timers; freeze only the undo interval.
      await page.clock.pauseAt(new Date("2026-10-20T12:05:00Z"))
      await confirmation.getByRole("button", { name: "Apagar", exact: true }).click()
      await expect(page.locator(".thread-delete-toast")).toContainText("Desfazer")
      await screenshot("after-undo-toast")
      if (width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
      await page.getByRole("button", { name: "Desfazer", exact: true }).click()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      // The phone drawer remounts the sidebar, so its conversation list starts collapsed again.
      if (width === 390) await openConversations(page)
      await expect(row).toBeVisible()
      await menuButton.click()
      await page.getByRole("menuitem", { name: "Apagar conversa…" }).click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Apagar", exact: true }).click()
      if (width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
      await page.clock.fastForward(5100)
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await expect(row).toBeHidden()
      await screenshot("after-delete")
    })
  }
}

test("archived messages remain searchable and restore when opened", async ({ page }) => {
  await page.goto("/test/e2e/thread-deletion-harness.html?archived=1")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await chooseBotAction(page, "Arquivadas")
  await expect(page.getByRole("button", { name: "Abrir conversa arquivada Eventos de leads" })).toBeVisible()
  await mkdir(evidenceDirectory, { recursive: true })
  await page.locator(".archived-thread-list").screenshot({ path: join(evidenceDirectory, "archive-list.png") })
  await page.getByRole("button", { name: "Buscar conversas", exact: true }).click()
  const search = page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })
  await search.fill("atualização automática")
  const result = page.getByRole("option", { name: /Uma atualização automática de exemplo/ })
  await expect(result).toBeVisible()
  await page
    .getByRole("dialog", { name: "Paleta de comandos" })
    .screenshot({ path: join(evidenceDirectory, "archive-search.png") })
  await result.click()

  await expect(page.getByText("Uma atualização automática de exemplo.", { exact: true })).toBeVisible()
  await expect((await openConversations(page)).locator(".thread-row.selected")).toContainText("Eventos de leads")
  await page
    .locator('[data-message-id="message-lead-event"]')
    .screenshot({ path: join(evidenceDirectory, "archive-restored.png") })
})

test("archived conversation titles remain searchable after reopening", async ({ page }) => {
  await page.goto("/test/e2e/thread-deletion-harness.html?archived=1")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.getByRole("button", { name: "Buscar conversas", exact: true }).click()
  await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("EVENTOS leads")
  const result = page.getByRole("option", { name: /Eventos de leads/ })
  await expect(result).toContainText("Arquivadas")
  await mkdir(evidenceDirectory, { recursive: true })
  await page
    .getByRole("dialog", { name: "Paleta de comandos" })
    .screenshot({ path: join(evidenceDirectory, "archive-title-search.png") })
  await result.click()

  await expect(page.getByRole("button", { name: "Conversas de mark", exact: true })).toBeVisible()
  await expect((await openConversations(page)).locator(".thread-row.selected")).toContainText("Eventos de leads")
})
