import { expect, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"
import { showBotDetails, showBotRoutines } from "./home-navigation"

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
  await showBotDetails(page)
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

test("r3 run-now rejects a second keyboard activation through the routine menu", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/home-harness.html")
  await showBotRoutines(page)
  const trigger = page.getByRole("button", { name: "Ações da rotina Daily brief", exact: true })
  await trigger.focus()
  await trigger.press("Enter")
  const action = page.getByRole("menuitem", { name: "Rodar agora", exact: true })

  await action.press("Enter")
  await trigger.press("Space")
  await expect(action).toBeDisabled()

  expect(
    await page.evaluate(() => {
      const fixture: { api: ReturnType<typeof createMockApi> } = Reflect.get(window, "workspaceQa")
      return fixture.api.calls.filter((call) => call.route === "POST /routines/:id/run").length
    }),
  ).toBe(1)
})
