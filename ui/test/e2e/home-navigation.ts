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
  if (await page.locator(".bot-panel").isVisible()) return

  const trigger = page.getByRole("button", { name: "Painel do bot", exact: true })
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
}

export const showBotDetails = async (page: Page): Promise<void> => {
  await showBotPanel(page)
  const adjust = page.getByRole("button", { name: "Ajustar", exact: true })
  if ((await adjust.getAttribute("aria-expanded")) === "false") await adjust.click()
}

export const openGlobalPage = async (page: Page, name: string): Promise<void> => {
  await page.locator("button.sidebar-connect[aria-controls='sidebar-advanced-pages']").click()
  const menu = page.getByRole("navigation", { name: "Opções avançadas" })
  const groupByPage: Record<string, string> = {
    MCP: "Ferramentas",
    Integrações: "Ferramentas",
    "Modelos por API": "Ferramentas",
    Trabalho: "Trabalho",
    Pessoas: "Trabalho",
    Desempenho: "Diagnóstico",
    "Reportar problema": "Diagnóstico",
  }
  const section = groupByPage[name] ?? (name.startsWith("Verificar") ? "Diagnóstico" : undefined)
  if (section) await menu.getByRole("button", { name: section, exact: true }).click()
  await menu.getByRole("button", { name, exact: true }).last().click()
}

export const showBotChat = async (page: Page, botId = "bot-mark"): Promise<void> => {
  await page.getByRole("tab", { name: /^Bots/ }).click()
  await page.locator(`[data-bot-entry="${botId}"] .bot-row-main`).click()
}

export const showWorkMode = async (page: Page): Promise<void> => {
  const workTab = page.getByRole("tab", { name: /^Work/ })
  const openDrawer = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (!(await workTab.isVisible()) && (await openDrawer.isVisible())) await openDrawer.click()
  await expect(workTab).toBeVisible()
  if ((await workTab.getAttribute("aria-selected")) === "true") return

  await workTab.click()
  if (await workTab.isVisible()) return

  if (await openDrawer.isVisible()) await openDrawer.click()
  await expect(workTab).toBeVisible()
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

export const chooseBotAction = async (page: Page, action: string, name = "mark"): Promise<void> => {
  const conversationActions: Record<string, string> = {
    "Nova conversa": "Nova conversa",
    "Selecionar conversas…": "Selecionar",
    Arquivadas: "Arquivadas",
    "Apagar conversas automáticas antigas…": "Apagar conversas automáticas antigas…",
  }
  const nested = conversationActions[action]
  if (nested) {
    const management = await showBotConversations(page, name)
    await management.getByRole("button", { name: new RegExp(`^${nested}`) }).click()
    return
  }
  await openBotActions(page, name)
  await page.getByRole("menuitem", { name: action, exact: true }).click()
}

export const openConversations = showBotConversations

export const chooseChannelAction = async (page: Page, channel: string, action: string): Promise<void> => {
  await page
    .locator(".group-header")
    .getByRole("button", { name: `Ações do canal ${channel}`, exact: true })
    .click()
  await page.getByRole("menuitem", { name: action, exact: true }).click()
}

export const showServerSettings = async (page: Page): Promise<void> => {
  const dialog = page.getByRole("dialog")
  const section = dialog.getByRole("tab", { name: "Avançado", exact: true })
  if (await section.isVisible()) {
    await section.click()
    return
  }
  await dialog.getByRole("tab", { name: "Diagnóstico", exact: true }).click()
  await dialog.getByRole("button", { name: "Usar um servidor touri", exact: true }).click()
}

export const chooseRoutineAction = async (page: Page, name: string, action: string): Promise<void> => {
  await page.getByRole("button", { name: `Ações da rotina ${name}`, exact: true }).click()
  await page.getByRole("menuitem", { name: action, exact: true }).click()
}

export const openMessageActions = async (page: Page): Promise<void> => {
  const trigger = page.getByRole("button", { name: "Ações da mensagem", exact: true }).last()
  await trigger.focus()
  await trigger.click()
}
