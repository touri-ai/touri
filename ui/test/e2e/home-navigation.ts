import type { Page } from "@playwright/test"

export const showBotPanel = async (page: Page): Promise<void> => {
  const trigger = page.getByRole("button", { name: "Painel do bot", exact: true })
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
}

export const openGlobalPage = async (page: Page, name: string): Promise<void> => {
  await page.getByRole("button", { name: "Avançado", exact: true }).click()
  await page.getByRole("navigation", { name: "Opções avançadas" }).getByRole("button", { name, exact: true }).click()
}

export const showBotChat = async (page: Page, botId = "bot-mark"): Promise<void> => {
  await page.getByRole("tab", { name: /^Bots/ }).click()
  await page.locator(`[data-bot-entry="${botId}"] .bot-row-main`).click()
}

export const showBotRoutines = async (page: Page, name = "mark"): Promise<void> => {
  await page.getByRole("button", { name: `Ações de ${name}`, exact: true }).click()
  await page.getByRole("menuitem", { name: "Rotinas", exact: true }).click()
}

export const showBotAdvanced = async (page: Page, name = "mark"): Promise<void> => {
  await page.getByRole("button", { name: `Ações de ${name}`, exact: true }).click()
  await page.getByRole("menuitem", { name: "Avançado", exact: true }).click()
}
