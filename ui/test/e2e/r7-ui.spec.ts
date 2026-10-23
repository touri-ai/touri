import { expect, test } from "@playwright/test"
import { openGlobalPage, showBotDetails } from "./home-navigation"

test.use({ channel: "chromium", viewport: { width: 1440, height: 900 } })
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/r7-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
})

test("GFM task lists show checkboxes without bullet markers in the chat and compact Preview", async ({ page }) => {
  const chat = page.locator(".message-bubble")
  await expect(chat.getByRole("checkbox")).toHaveCount(2)
  await expect(chat.locator(".task-list-item").first()).toHaveCSS("list-style-type", "none")
  await expect(chat.getByText("Bullet comum", { exact: true })).toHaveCSS("list-style-type", "disc")
  const linkColor = await chat
    .getByRole("link", { name: "Documentação" })
    .evaluate((element) => getComputedStyle(element).color)
  await showBotDetails(page)
  await page.getByRole("button", { name: "Preview do projeto" }).click()
  const preview = page.locator(".preview-chat-feed")
  await expect(preview.getByRole("heading", { name: "Resultado" })).toBeVisible()
  await expect(preview.locator(".task-list-item").first()).toHaveCSS("list-style-type", "none")
  await expect(preview.getByRole("link", { name: "Documentação" })).toHaveCSS("color", linkColor)
  expect(
    await preview
      .locator(".markdown-content")
      .last()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeLessThan(14)
})

test("bot MCP settings keep the name and close button visible after scrolling", async ({ page }) => {
  await openGlobalPage(page, "Integrações")
  await page.getByRole("button", { name: "Configurar MCP de mark" }).click()
  const dialog = page.getByRole("dialog", { name: "Configurações de mark" })
  await expect(dialog.getByRole("region", { name: "Servidores MCP deste bot" })).toBeFocused()
  await dialog.evaluate((element) => {
    const pane = element.querySelector(".settings-pane:not([hidden])") ?? element
    pane.scrollTop = pane.scrollHeight
  })
  const header = dialog.locator(".modal-header")
  await expect(header).toHaveCSS("position", "sticky")
  await expect(header.getByRole("heading", { name: "Configurações de mark" })).toBeInViewport()
  await expect(header.getByRole("button", { name: "Fechar diálogo" })).toBeInViewport()
  expect(
    await header.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.right - 20, box.top + 20))
    }),
  ).toBe(true)
})

test("preferences visually separate shortcut and browser labels from their values", async ({ page }) => {
  await page.getByRole("button", { name: "Você", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Configurações" })
  await expect(settings.getByText("preferências locais", { exact: true })).toBeVisible()
  for (const [section, disclosure] of [
    ["Aparência", "Chat, barra lateral e atalhos"],
    ["Privacidade", "Dados, permissões e conexões"],
  ] as const) {
    await settings.getByRole("tab", { name: section }).click()
    await settings.getByText(disclosure, { exact: true }).click()
    const row = settings.locator(".settings-pane:not([hidden]) .settings-note > div")
    await expect(row).toBeVisible()
    const gap = await row.evaluate((element) => {
      const label = element.querySelector("span")?.getBoundingClientRect()
      const value = element.querySelector("code")?.getBoundingClientRect()
      return label && value ? value.left - label.right : 0
    })
    expect(gap).toBeGreaterThanOrEqual(8)
  }
})
