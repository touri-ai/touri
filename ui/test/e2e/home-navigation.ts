import { expect, type Page } from "@playwright/test"

export const showBotConversations = async (page: Page, name = "mark") => {
  const conversations = page.getByRole("region", { name: `Conversas de ${name}` })
  if (await conversations.isVisible()) return conversations

  const drawerButton = page.getByRole("button", { name: "Abrir menu", exact: true })
  const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  if ((await drawerButton.isVisible()) && !(await drawer.isVisible())) await drawerButton.click()
  await openBotActions(page, name)
  await page.getByRole("menuitem", { name: "Conversas", exact: true }).click()
  await expect(conversations).toBeVisible()

  return conversations
}

export const showBotPanel = async (page: Page): Promise<void> => {
  const trigger = page.getByRole("button", { name: "Painel do bot", exact: true })
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
}

export const openGlobalPage = async (page: Page, name: string): Promise<void> => {
  await page.locator("button.sidebar-connect[aria-controls='sidebar-advanced-pages']").click()
  await page.getByRole("navigation", { name: "Opções avançadas" }).getByRole("button", { name, exact: true }).click()
}

export const showBotChat = async (page: Page, botId = "bot-mark"): Promise<void> => {
  await page.getByRole("tab", { name: /^Bots/ }).click()
  await page.locator(`[data-bot-entry="${botId}"] .bot-row-main`).click()
}

export const openBotActions = async (page: Page, name = "mark"): Promise<void> => {
  const trigger = page.getByRole("button", { name: `Ações de ${name}`, exact: true })
  await page.locator(".sidebar-row").filter({ has: trigger }).hover()
  await trigger.click()
}

export const showBotRoutines = async (page: Page, name = "mark"): Promise<void> => {
  await openBotActions(page, name)
  await page.getByRole("menuitem", { name: "Rotinas", exact: true }).click()
}

export const showBotAdvanced = async (page: Page, name = "mark"): Promise<void> => {
  await openBotActions(page, name)
  await page.getByRole("menuitem", { name: "Avançado", exact: true }).click()
}
