import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { Bot } from "@touri/contracts"
import { showBotAdvanced } from "./home-navigation"
import { createWorkGoldenServer } from "./work-golden-server"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(120_000)
const servers = new Set<Awaited<ReturnType<typeof createWorkGoldenServer>>>()
test.afterEach(async () => {
  await Promise.all(Array.from(servers).map((server) => server.dispose()))
  servers.clear()
})

const openSettings = async (page: Page) => {
  await expect(page.getByRole("textbox", { name: "Mensagem para Lia", exact: true })).toBeVisible()
  const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if ((await menu.isVisible()) && !(await drawer.isVisible())) await menu.click()
  await showBotAdvanced(page, "Lia")
  const settings = page.getByRole("dialog", { name: "Configurações de Lia", exact: true })
  await settings.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()

  return settings
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`paid fast mode persists through restart at ${width} in ${theme}`, async ({ page }, info) => {
      const server = await createWorkGoldenServer()
      servers.add(server)
      const { bot } = (await server.api("/bots", "POST", { name: "Lia", provider: "codex" })) as { bot: Bot }
      expect(bot.serviceTier).toBeNull()
      await server.install(page)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.goto(server.serverUrl)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const settings = await openSettings(page)
      const toggle = settings.getByRole("switch", { name: "Modo rápido", exact: true })
      await expect(toggle).not.toBeChecked()
      await expect(toggle).toHaveAccessibleDescription("Respostas mais rápidas, com custo maior")

      await toggle.click()
      await expect(toggle).toBeChecked()
      expect(
        ((await server.api("/bots")).bots as Bot[]).find((candidate) => candidate.id === bot.id)?.serviceTier,
      ).toBe("fast")
      await toggle.scrollIntoViewIfNeeded()
      const directory = process.env.TOURI_SERVICE_TIER_EVIDENCE_DIR
      if (directory) await mkdir(directory, { recursive: true })
      const filename = `fast-mode-${width}-${theme}.png`
      await page.screenshot({ path: directory ? join(directory, filename) : info.outputPath(filename) })
      expect(await settings.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

      await settings.getByRole("button", { name: "Salvar configurações", exact: true }).click()
      await expect(settings).toHaveCount(0)
      await server.restart()
      await page.reload()
      const reopened = await openSettings(page)
      const persisted = reopened.getByRole("switch", { name: "Modo rápido", exact: true })
      await expect(persisted).toBeChecked()
      await persisted.click()
      await expect(persisted).not.toBeChecked()
      expect(
        ((await server.api("/bots")).bots as Bot[]).find((candidate) => candidate.id === bot.id)?.serviceTier,
      ).toBeNull()

      await reopened.getByRole("combobox", { name: "Provedor", exact: true }).selectOption("claude")
      await expect(reopened.getByRole("switch", { name: "Modo rápido", exact: true })).toHaveCount(0)
    })
  }
}
