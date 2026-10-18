import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })

const hosts = [
  { host: "server", noun: "servidor" },
  { host: "computer", noun: "computador" },
] as const

hosts.forEach(({ host, noun }) => {
  test(`host-label: ${host} sidecar overrides a Mac browser`, async ({ page }) => {
    await setMacBrowser(page)

    await page.goto(`/test/e2e/r8-composer-harness.html?host=${host}`)
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()

    const panel = page.getByRole("complementary", { name: "Painel de mark" })
    await expect(panel.getByText(`Trabalha neste ${noun}.`)).toBeVisible()
    await expect(panel).not.toContainText("Mac")
    expect(await page.evaluate(() => navigator.platform)).toBe("MacIntel")

    await page.locator(".sidebar-advanced").getByRole("button", { name: "Avançado", exact: true }).click()

    await expect(page.getByRole("button", { name: `Verificar este ${noun}`, exact: true })).toBeVisible()
    await captureHostLabel(page, `${host}-details.png`)

    await page.locator(".sidebar-advanced").getByRole("button", { name: "Avançado", exact: true }).click()
    await panel.getByRole("button", { name: "Ajustar permissões", exact: true }).click()

    const permissions = page.getByRole("dialog", { name: "Permissões do bot", exact: true })
    await expect(permissions.getByRole("switch", { name: `Acesso a qualquer pasta deste ${noun}` })).toBeVisible()
    await expect(permissions).not.toContainText("neste Mac")
    await captureHostLabel(page, `${host}-permissions.png`)
  })
})

const setMacBrowser = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" })
  })

const captureHostLabel = async (page: Page, filename: string) => {
  const directory = process.env.TOURI_HOSTLABEL_SHOTS
  if (!directory) return

  await page.screenshot({ path: join(directory, filename), animations: "disabled" })
}
