import { expect, type Page, test } from "@playwright/test"
import type { ApiRequest } from "../../src/api/client"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const openSidebar = async (page: Page): Promise<void> => {
  const trigger = page.getByRole("button", { name: "Abrir menu", exact: true })
  const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  if ((await trigger.isVisible()) && !(await drawer.isVisible())) await trigger.click()
}

const closeSidebar = async (page: Page): Promise<void> => {
  const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  if (await drawer.isVisible()) await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
}

const switchMode = async (page: Page, mode: "Bots" | "Work"): Promise<void> => {
  await openSidebar(page)
  await page.getByRole("tab", { name: new RegExp(`^${mode}`) }).click()
  await closeSidebar(page)
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`each mode reopens its own last conversation at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const fixture = window as Window & { groupsQa?: { api: { request: ApiRequest } } }
      const api = fixture.groupsQa?.api
      if (!api) throw new Error("Missing group fixture")

      await api.request("POST /groups", {
        name: "Planejamento",
        color: "#2563eb",
        avatarShape: "classic-none",
        memberIds: ["bot-mark", "bot-onb"],
        coordinatorBotId: null,
      })
    })

    await switchMode(page, "Work")
    await openSidebar(page)
    await page
      .getByRole("region", { name: "Canais", exact: true })
      .getByRole("button", { name: /^Planejamento/ })
      .click()
    await closeSidebar(page)
    const channel = page.getByRole("textbox", { name: "Mensagem para Planejamento", exact: true })
    await expect(channel).toBeVisible()
    await channel.fill("Rascunho do canal")

    await switchMode(page, "Bots")
    await expect(channel).toHaveCount(0)
    await openSidebar(page)
    await page.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
    await closeSidebar(page)
    const direct = page.getByRole("textbox", { name: "Mensagem para onb", exact: true })
    await expect(direct).toBeVisible()
    await direct.fill("Rascunho da conversa")

    await switchMode(page, "Work")
    await expect(channel).toBeVisible({ timeout: 1000 })
    await expect(channel).toHaveValue("Rascunho do canal")
    await expect(direct).toHaveCount(0)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/work-restored-${viewport.width}.png` })

    await switchMode(page, "Bots")
    await expect(direct).toBeVisible({ timeout: 1000 })
    await expect(direct).toHaveValue("Rascunho da conversa")
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/bots-restored-${viewport.width}.png` })
  })
}
