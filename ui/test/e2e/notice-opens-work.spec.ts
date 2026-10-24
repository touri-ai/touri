import { expect, type Page, test } from "@playwright/test"
import type { ApiRequest } from "../../src/api/client"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const openSidebar = async (page: Page): Promise<void> => {
  const trigger = page.getByRole("button", { name: "Abrir menu", exact: true })
  const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  if ((await trigger.isVisible()) && !(await drawer.isVisible())) await trigger.click()
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a channel notice opened from Bots selects Work at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "bots"))
    await page.goto("/test/e2e/groups-harness.html")
    const direct = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(direct).toBeVisible()
    await direct.fill("Rascunho da conversa")
    await page.evaluate(async () => {
      const fixture = window as Window & {
        groupsQa?: { api: { request: ApiRequest; notify: (input: Record<string, unknown>) => unknown } }
      }
      const api = fixture.groupsQa?.api
      if (!api) throw new Error("Missing group fixture")
      const { group } = await api.request("POST /groups", {
        name: "Relatórios",
        color: "#2563eb",
        avatarShape: "classic-none",
        memberIds: ["bot-mark", "bot-onb"],
        coordinatorBotId: null,
      })
      const { threads } = await api.request("GET /groups/:id/threads", {}, { id: group.id })
      api.notify({
        kind: "done",
        botId: "bot-onb",
        threadId: threads[0]?.id,
        title: "Concluído",
        body: "Relatório pronto.",
      })
    })

    await openSidebar(page)
    await page.getByRole("button", { name: /^Notificações/ }).click()
    await page
      .getByRole("region", { name: "Central de notificações" })
      .getByRole("button", { name: "Ver conversa", exact: true })
      .click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Relatórios", exact: true })).toBeVisible()
    await openSidebar(page)
    // Work loads its navigation on first opening; wait for it when it is the selected mode.
    await page
      .getByRole("region", { name: "Canais", exact: true })
      .getByRole("button", { name: /^Relatórios/ })
      .waitFor({ timeout: 3_000 })
      .catch(() => undefined)
    // Captured before the tab assertion so the same spec records the wrong tab on main.
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/notice-work-${viewport.width}.png` })
    await expect(page.getByRole("tab", { name: /^Work/ })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("tab", { name: /^Bots/ })).toHaveAttribute("aria-selected", "false")

    await page.getByRole("tab", { name: /^Bots/ }).click()
    if (await page.getByRole("dialog", { name: "Barra lateral", exact: true }).isVisible())
      await page.keyboard.press("Escape")
    await expect(direct).toHaveValue("Rascunho da conversa")
    // Reopening the phone drawer remounts the sidebar; it must stay on the mode the person chose.
    await openSidebar(page)
    await expect(page.getByRole("tab", { name: /^Bots/ })).toHaveAttribute("aria-selected", "true")
  })
}
