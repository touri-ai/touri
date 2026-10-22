import { expect, type Locator, type Page, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"
import { showBotAdvanced, showWorkMode } from "./home-navigation"

type MascotEditorWindow = Window & { groupsQa: { api: ReturnType<typeof createMockApi> } }

const viewports = [
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
]

viewports.forEach((viewport) => {
  test.describe(`compact mascot editor at ${viewport.width}px`, () => {
    test.describe.configure({ timeout: 90_000 })
    test.use({ viewport, locale: "pt-BR", reducedMotion: "reduce" })

    test("bot creation and settings keep randomization compact and persist the selected look", async ({ page }) => {
      await page.goto("/test/e2e/groups-harness.html")
      await showNavigation(page)
      await page.getByRole("button", { name: "Criar bot", exact: true }).click()
      const creation = page.getByRole("dialog")
      await expectCompactPicker(creation)
      await creation.getByLabel("Nome", { exact: true }).fill("Compact bot")

      await creation.getByRole("button", { name: "Sortear", exact: true }).click()
      const chosen = await getPreview(creation)
      await creation.getByRole("button", { name: "Criar bot", exact: true }).click()

      await expect(page.getByRole("textbox", { name: "Mensagem para Compact bot", exact: true })).toBeVisible()
      const saved = await page.evaluate(() => {
        const fixture = window as MascotEditorWindow
        const bot = fixture.groupsQa.api.getState().bots.find((bot) => bot.name === "Compact bot")

        return { shape: bot?.avatarShape, color: bot?.color, seed: bot?.avatarSeed }
      })
      expect(saved).toMatchObject({ shape: chosen.shape, color: chosen.color })
      expect(saved.seed).toBeTruthy()
      await openBotSettings(page, "Compact bot")
      const settings = page.getByRole("dialog", { name: "Configurações de Compact bot", exact: true })
      await expectCompactPicker(settings)
      expect(await getPreview(settings)).toEqual(chosen)

      await settings.getByRole("button", { name: "Personalizar", exact: true }).click()

      await expect(settings.getByRole("button", { name: "Personalizar", exact: true })).toHaveAttribute(
        "aria-expanded",
        "true",
      )
      await expect(settings.getByRole("radio", { name: "Chifres Longos", exact: true })).toBeVisible()
      await expectNoStatePreview(settings)

      await settings.getByRole("button", { name: "Personalizar", exact: true }).click()
      await expectCompactPicker(settings)
      await settings.getByRole("button", { name: "Sortear", exact: true }).click()
      const updated = await getPreview(settings)
      await settings.getByRole("button", { name: "Salvar configurações", exact: true }).click()
      await expect(settings).toHaveCount(0)
      await openBotSettings(page, "Compact bot")

      await expectCompactPicker(settings)
      expect(await getPreview(settings)).toEqual(updated)
      const persisted = await page.evaluate(() => {
        const fixture = window as MascotEditorWindow
        const bot = fixture.groupsQa.api.getState().bots.find((bot) => bot.name === "Compact bot")

        return { shape: bot?.avatarShape, color: bot?.color, seed: bot?.avatarSeed }
      })
      expect(persisted).toEqual({ shape: updated.shape, color: updated.color, seed: saved.seed })
    })

    test("channel creation and editing preserve a randomized mascot with customization closed", async ({ page }) => {
      await page.goto("/test/e2e/groups-harness.html")
      await showWorkMode(page)
      await page.getByRole("button", { name: "Criar canal", exact: true }).click()
      const creation = page.getByRole("dialog", { name: "Criar canal", exact: true })
      await expectCompactPicker(creation)
      await creation.getByLabel("Nome do canal").fill("Compact team")
      await creation.getByRole("checkbox", { name: "mark", exact: true }).check()

      await creation.getByRole("button", { name: "Sortear", exact: true }).click()
      const chosen = await getPreview(creation)
      await creation.getByRole("button", { name: "Criar canal", exact: true }).click()

      await expect(page.getByRole("textbox", { name: "Mensagem para Compact team", exact: true })).toBeVisible()
      await expect(page.locator(".channel-heading-name strong")).toHaveText("Compact team")

      const channelActions = page
        .locator("header.channel-mode")
        .getByRole("button", { name: "Ações do canal Compact team", exact: true })
      await channelActions.click()
      await page.getByRole("menuitem", { name: "Editar canal", exact: true }).click()
      const editing = page.getByRole("dialog", { name: "Editar canal", exact: true })
      await expectCompactPicker(editing)
      expect(await getPreview(editing)).toEqual(chosen)

      await editing.getByRole("button", { name: "Personalizar", exact: true }).click()
      await expect(editing.getByRole("button", { name: "Restaurar automático", exact: true })).toBeVisible()
      await expectNoStatePreview(editing)
      await editing.getByRole("button", { name: "Personalizar", exact: true }).click()
      await expectCompactPicker(editing)
      await editing.getByRole("button", { name: "Salvar canal", exact: true }).click()
      await expect(editing).toHaveCount(0)
      await channelActions.click()
      await page.getByRole("menuitem", { name: "Editar canal", exact: true }).click()

      await expectCompactPicker(editing)
      expect(await getPreview(editing)).toEqual(chosen)
    })
  })
})

const openBotSettings = async (page: Page, name: string) => {
  await showNavigation(page)
  await showBotAdvanced(page, name)
}

const getPreview = async (dialog: Locator) => {
  const avatar = dialog.locator(".avatar-picker-stage .tb-avatar")
  const body = avatar.locator("[data-avatar-body]")

  return {
    shape: await avatar.getAttribute("data-avatar-shape"),
    color: await body.getAttribute("fill"),
    head: await body.getAttribute("d"),
  }
}

const expectCompactPicker = async (dialog: Locator) => {
  const picker = dialog.locator(".avatar-picker")

  await expect(picker.getByRole("button")).toHaveCount(2)
  await expect(picker.getByRole("button", { name: "Sortear", exact: true })).toBeVisible()
  await expect(picker.getByRole("button", { name: "Personalizar", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  await expect(picker.getByRole("radio")).toHaveCount(0)
  await expectNoStatePreview(picker)
  const layout = await picker.evaluate((element) => {
    const legend = element.querySelector("legend")
    const card = element.querySelector(".avatar-picker-layout")
    if (!legend || !card) throw new Error("Missing mascot label or preview")

    return {
      height: element.getBoundingClientRect().height,
      labelBottom: legend.getBoundingClientRect().bottom,
      cardTop: card.getBoundingClientRect().top,
      overflow: element.scrollWidth - element.clientWidth,
    }
  })

  expect(layout.height).toBeLessThanOrEqual(150)
  expect(layout.cardTop).toBeGreaterThanOrEqual(layout.labelBottom)
  expect(layout.overflow).toBeLessThanOrEqual(1)
}

const expectNoStatePreview = async (scope: Locator) => {
  await expect(scope.getByRole("group", { name: "Pré-visualizar estado", exact: true })).toHaveCount(0)
  await expect(
    scope.getByRole("radio", { name: /^(Ocioso|Pensando|Trabalhando|Aguardando|Respondeu|Falhou|Dormindo)$/ }),
  ).toHaveCount(0)
  await expect(
    scope.getByRole("button", { name: /^(Ocioso|Pensando|Trabalhando|Aguardando|Respondeu|Falhou|Dormindo)$/ }),
  ).toHaveCount(0)
}

const showNavigation = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (!(await menu.isVisible())) return

  await menu.click()
}
