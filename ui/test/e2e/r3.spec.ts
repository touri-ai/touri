import { expect, test } from "@playwright/test"
import { showBotPanel, showBotRoutines } from "./home-navigation"

test("r3 ⌘K accepts typing and input clicks, finds bot names and navigates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.keyboard.press("Meta+k")
  const search = page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })
  await expect(search).toBeFocused()
  await search.click()
  await page.keyboard.type("onb")
  const result = page.getByRole("dialog", { name: "Paleta de comandos" }).getByRole("option", { name: /onb/ }).first()
  await result.click()
  await expect(search).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
})

test("r3 permissions panel exposes full approval access, provider defaults and bot MCP configuration", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await showBotPanel(page)
  await page.getByRole("button", { name: "Ajustar permissões" }).click()
  const panel = page.getByRole("dialog", { name: "Permissões do bot" })
  await expect(panel).toBeVisible()
  await panel.getByRole("combobox", { name: "Acesso", exact: true }).selectOption("full")
  await panel.getByRole("tab", { name: "Modelo", exact: true }).click()
  await panel.getByRole("combobox", { name: "Raciocínio", exact: true }).selectOption("")
  await panel.getByRole("tab", { name: "Ferramentas", exact: true }).click()
  await expect(panel.getByRole("region", { name: "Servidores MCP deste bot" })).toBeVisible()
  await panel.getByRole("button", { name: "Salvar configurações" }).click()
  await expect(panel).toHaveCount(0)
})

test("r3 run-now shows an immediate busy state and rejects the second keyboard activation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await showBotRoutines(page)
  const button = page.getByRole("button", { name: /Rodar agora/ }).first()
  await button.focus()
  await page.keyboard.press("Enter")
  await page.keyboard.press("Space")
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute("aria-busy", "true")
})
