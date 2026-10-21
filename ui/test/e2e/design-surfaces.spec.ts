import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import { showBotAdvanced, showBotRoutines } from "./home-navigation"

const viewports = [
  { width: 1440, height: 900, theme: "dark" },
  { width: 1024, height: 700, theme: "light" },
  { width: 390, height: 844, theme: "light" },
] as const

for (const viewport of viewports) {
  test.describe(`design surfaces at ${viewport.width}x${viewport.height}`, () => {
    test.use({
      viewport,
      isMobile: viewport.width === 390,
      hasTouch: viewport.width === 390,
      reducedMotion: "reduce",
      locale: "pt-BR",
    })
    test.setTimeout(180_000)

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), viewport.theme)
    })

    test("workspace, routines and dialogs stay reachable", async ({ page }, info) => {
      await page.goto("/test/e2e/home-harness.html?scenario=long-composer")
      await expect(page.locator(".composer-island")).toBeVisible()
      await captureSurface(page, info, "composer")
      await openSidebar(page)
      await captureSurface(page, info, "sidebar")
      await showBotAdvanced(page)
      await expect(page.locator(".settings-modal")).toBeVisible()
      await captureSurface(page, info, "bot-settings")
      await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()

      await openSidebar(page)
      await showBotRoutines(page)
      await expect(page.locator(".cron-screen")).toBeVisible()
      await captureSurface(page, info, "routines")
      await page.getByRole("button", { name: "Criar rotina", exact: true }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await captureSurface(page, info, "routine-editor")
      await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()

      await openSidebar(page)
      await page.getByRole("button", { name: /Você Local/ }).click()
      await expect(page.locator(".settings-nav")).toBeVisible()
      await captureSurface(page, info, "preferences")
      await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()
      await openSidebar(page)
      await page.getByRole("button", { name: "Criar bot", exact: true }).first().click()
      await expect(page.locator(".bot-create-modal")).toBeVisible()
      await captureSurface(page, info, "create-bot")
      await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()

      await openSidebar(page)
      await page.getByRole("button", { name: "Ações de mark", exact: true }).click()
      await page.getByRole("menuitem", { name: "Excluir bot", exact: true }).click()
      await expect(page.getByLabel("Digite o nome do bot: mark")).toBeVisible()
      await captureSurface(page, info, "delete-bot")
      await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()

      await page.keyboard.press("Control+k")
      await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("Conectar projeto")
      await page.getByRole("option", { name: /Conectar projeto/ }).click()
      await expect(page.getByRole("dialog", { name: "Conectar projeto", exact: true })).toBeVisible()
      await captureSurface(page, info, "project")
      await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()

      await openSidebar(page)
      await page.getByRole("button", { name: "Criar grupo", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "Criar grupo", exact: true })).toBeVisible()
      await captureSurface(page, info, "group")
    })

    test("notices, empty states and tool status fit the viewport", async ({ page }, info) => {
      await page.goto("/test/e2e/notification-center-harness.html")
      await openSidebar(page)
      await page.locator(".notification-bell").click()
      await expect(page.getByRole("region", { name: "Central de notificações" })).toBeVisible()
      await captureSurface(page, info, "notifications")

      await page.goto("/test/e2e/home-harness.html?scenario=failed")
      await expect(page.locator(".message-error").first()).toBeVisible()
      await captureSurface(page, info, "error-recovery")
      await page.goto("/test/e2e/approval-notice-harness.html")
      await expect(page.locator(".approval-notice")).toBeVisible()
      await captureSurface(page, info, "approval-notice")
      await page.goto("/test/e2e/approval-harness.html?scene=read")
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, viewport.theme)
      await captureSurface(page, info, "approval")
      await page.goto(`/test/e2e/saved-output-harness.html?theme=${viewport.theme}`)
      const header = page.locator(".tool-card-header")
      await expect(header.locator(".tool-status-chip")).toContainText("Concluído")
      await captureSurface(page, info, "command")

      const centers = await Promise.all(
        [".tool-exit-chip", ".tool-status-chip"].map((selector) =>
          header.locator(selector).evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            return bounds.top + bounds.height / 2
          }),
        ),
      )
      expect.soft(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
      if (viewport.width > 600) {
        const title = await header.locator("strong").boundingBox()
        expect.soft(Math.abs((title?.y ?? 0) + (title?.height ?? 0) / 2 - (centers[0] ?? 0))).toBeLessThanOrEqual(1)
      }

      await page.goto("/test/e2e/home-harness.html?scenario=empty")
      await expect(page.getByRole("button", { name: "Criar meu primeiro bot", exact: true })).toBeVisible()
      await captureSurface(page, info, "onboarding")
      await page.getByRole("button", { name: "Importar", exact: true }).click()
      await expect(page.locator(".wizard-content")).toBeVisible()
      await captureSurface(page, info, "import")
    })
  })
}

test("phone navigation survives replacing a bot routine header", async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/home-harness.html")
  await openSidebar(page)
  await showBotRoutines(page, "mark")
  await expect(page.locator(".cron-screen")).toBeVisible()
  const header = page.locator(".cron-screen .screen-header")
  await expect(header.getByRole("button", { name: "Abrir menu", exact: true })).toBeVisible()
  await openSidebar(page)

  await showBotRoutines(page, "onb")

  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  await expect(menu).toBeVisible()
  await expect(header.getByRole("button", { name: "Abrir menu", exact: true })).toBeVisible()
  const menuBounds = await menu.boundingBox()
  const copyBounds = await header.locator("div").first().boundingBox()
  if (!menuBounds || !copyBounds) throw new Error("Missing phone header bounds")

  expect(copyBounds.x + copyBounds.width).toBeLessThanOrEqual(menuBounds.x)
  await menu.click()
  await expect(page.getByRole("dialog", { name: "Barra lateral", exact: true })).toBeVisible()
})

const openSidebar = async (page: Page): Promise<void> => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (!(await menu.isVisible())) return

  await menu.click()
}

const captureSurface = async (page: Page, info: TestInfo, surface: string): Promise<void> => {
  await page.evaluate(() => document.fonts.ready)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect.soft(overflow, `${surface} page overflow`).toBeLessThanOrEqual(1)
  const panels = page.locator(".modal-card, .notification-popover, .cron-screen, .composer-island")
  const overflows = await panels.evaluateAll((elements) =>
    elements.map((element) => element.scrollWidth - element.clientWidth),
  )
  expect
    .soft(
      overflows.every((value) => value <= 1),
      `${surface} panel overflow`,
    )
    .toBe(true)
  const directory = process.env.TOURI_DESIGN_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  const viewport = page.viewportSize()
  const phase = process.env.TOURI_DESIGN_PHASE ?? "after"
  const filename = `${phase}-${viewport?.width}x${viewport?.height}-${surface}.png`
  const path = join(directory, filename)
  await page.screenshot({ path, animations: "disabled" })
  await info.attach(surface, { path, contentType: "image/png" })
}
