import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"

const views = [
  { name: "desktop", width: 1280, height: 900, theme: "light" },
  { name: "phone", width: 390, height: 844, theme: "dark" },
]

views.forEach(({ name, width, height, theme }) => {
  test(`model picker keeps its design scale and keyboard focus: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/r8-composer-harness.html")
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)
    const trigger = page.locator(".composer .model-picker-trigger")

    await trigger.focus()
    await trigger.press("ArrowDown")

    await expect(trigger).toHaveCSS("font-size", "12px")
    await expect(trigger).toHaveCSS("padding-left", "8px")
    const popover = page.locator(".model-picker-popover")
    await expect(popover).toBeVisible()
    await expect(popover).toHaveCSS("padding", "8px")
    await expect(popover).toHaveCSS("border-radius", "14px")
    const selected = popover.getByRole("option", { selected: true })
    await expect(selected).toBeFocused()
    await expect(selected).toHaveCSS("font-size", "13px")
    await expect(selected).toHaveCSS("padding-left", "8px")
    await expect(selected).toHaveCSS("border-radius", "10px")
    expect(await popover.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    await selected.press("Escape")

    await expect(popover).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test(`invalid stored model explains recovery: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })

    await page.goto("/test/e2e/error-contract-harness.html?scenario=invalid-model")
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)

    const card = page.locator(".message-error").first()
    await expect(card).toBeVisible()
    await expect(card).toContainText(
      "O nome do modelo salvo é inválido. Escolha outro modelo nas configurações do bot.",
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const shots = process.env.TOURI_MODEL_SETTINGS_SHOTS
    if (shots) {
      await mkdir(shots, { recursive: true })
      await page.screenshot({ path: join(shots, `invalid-model-${name}.png`) })
    }
  })

  test(`settings keeps provider and model together on cancel and save: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/r8-composer-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await page.evaluate(async (theme) => {
      document.documentElement.dataset.theme = theme
      const api: ReturnType<typeof createMockApi> = Reflect.get(window, "r8ComposerApi")
      await api.request("PATCH /bots/:id", { provider: "claude", model: "sonnet" }, { id: "bot-mark" })
    }, theme)
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await page.getByRole("button", { name: /^Modelo:/ }).click()
    const dialog = page.getByRole("dialog", { name: "Configurações de mark" })
    await dialog.getByLabel("Provedor", { exact: true }).selectOption("codex")
    await dialog.locator("#settings-model").click()
    await dialog.getByRole("option", { name: "gpt-6.1-sol" }).click()
    await expect(dialog.locator("#settings-model")).toHaveAccessibleName("Escolher modelo: Codex · gpt-6.1-sol")
    const getStoredChoice = () =>
      page.evaluate(() => {
        const api: ReturnType<typeof createMockApi> = Reflect.get(window, "r8ComposerApi")
        const bot = api.getState().bots.find((bot) => bot.id === "bot-mark")
        return { provider: bot?.provider, model: bot?.model }
      })

    expect(await getStoredChoice()).toEqual({ provider: "claude", model: "sonnet" })
    const shots = process.env.TOURI_MODEL_SETTINGS_SHOTS
    if (shots) {
      await mkdir(shots, { recursive: true })
      await page.screenshot({ path: join(shots, `model-settings-unsaved-${name}.png`) })
    }
    await dialog.getByRole("button", { name: "Cancelar", exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(await getStoredChoice()).toEqual({ provider: "claude", model: "sonnet" })

    await page.getByRole("button", { name: /^Modelo:/ }).click()
    await dialog.getByLabel("Provedor", { exact: true }).selectOption("codex")
    await dialog.locator("#settings-model").click()
    await dialog.getByRole("option", { name: "gpt-6.1-sol" }).click()
    await dialog.getByRole("button", { name: "Salvar configurações" }).click()

    await expect(dialog).toBeHidden()
    expect(await getStoredChoice()).toEqual({ provider: "codex", model: "gpt-6.1-sol" })
    await page.getByRole("button", { name: "Fechar painel do bot", exact: true }).click()
    await expect(page.getByRole("button", { name: "Escolher modelo: Codex · gpt-6.1-sol" })).toBeVisible()
    if (shots) await page.screenshot({ path: join(shots, `model-settings-saved-${name}.png`) })
  })
})

test("settings saves a different API model and the provider default", async ({ page }) => {
  await page.goto("/test/e2e/r8-composer-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.evaluate(async () => {
    const api: ReturnType<typeof createMockApi> = Reflect.get(window, "r8ComposerApi")
    const { model } = await api.request("POST /api-models", {
      preset: "custom",
      baseUrl: "https://example.com/v1",
      apiKey: "fixture-model-key",
      name: "Demo API",
      modelId: "demo-model",
    })
    await api.request("PATCH /bots/:id", { provider: "opencode", model: null }, { id: "bot-mark" })
    return model.id
  })
  await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
  await page.getByRole("button", { name: /^Modelo:/ }).click()
  const dialog = page.getByRole("dialog", { name: "Configurações de mark" })
  await dialog.getByLabel("Modelos por API", { exact: true }).selectOption({ label: "Demo API · demo-model" })
  await dialog.getByRole("button", { name: "Salvar configurações" }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Escolher modelo: Modelos por API · demo-model" })).toBeVisible()
  await page.getByRole("button", { name: /^Modelo:/ }).click()
  await dialog.getByLabel("Modelos por API", { exact: true }).selectOption("")
  await dialog.getByRole("button", { name: "Salvar configurações" }).click()

  await expect(dialog).toBeHidden()
  expect(
    await page.evaluate(() => {
      const api: ReturnType<typeof createMockApi> = Reflect.get(window, "r8ComposerApi")
      return api.getState().bots.find((bot) => bot.id === "bot-mark")?.model
    }),
  ).toBeNull()
})
