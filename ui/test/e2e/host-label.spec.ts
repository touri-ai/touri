import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })

const hosts = [
  { host: "server", noun: "servidor", platform: "MacIntel" },
  { host: "computer", noun: "computador", platform: "MacIntel" },
  { host: "mac", noun: "Mac", platform: "Linux x86_64" },
] as const

hosts.forEach(({ host, noun, platform }) => {
  test(`host-label: ${host} sidecar overrides the browser platform`, async ({ page }) => {
    await setBrowserPlatform(page, platform)

    await page.goto(`/test/e2e/r8-composer-harness.html?host=${host}`)
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()

    const panel = page.getByRole("complementary", { name: "Painel de mark" })
    await expect(panel.getByText(`Trabalha neste ${noun}.`)).toBeVisible()
    if (host !== "mac") await expect(panel).not.toContainText("Mac")
    expect(await page.evaluate(() => navigator.platform)).toBe(platform)

    await page
      .locator(".sidebar-advanced")
      .getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
      .click()

    await expect(page.getByRole("button", { name: `Verificar este ${noun}`, exact: true })).toBeVisible()
    await captureHostLabel(page, `${host}-details.png`)

    await page
      .locator(".sidebar-advanced")
      .getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
      .click()
    await panel.getByRole("button", { name: "Ajustar permissões", exact: true }).click()

    const permissions = page.getByRole("dialog", { name: "Permissões do bot", exact: true })
    const folderAccess = permissions.getByRole("switch", { name: `Acesso a qualquer pasta deste ${noun}` })
    await expect(folderAccess).toBeVisible()
    await folderAccess.scrollIntoViewIfNeeded()
    if (host !== "mac") await expect(permissions).not.toContainText("neste Mac")
    await captureHostLabel(page, `${host}-permissions.png`)
  })
})

const setBrowserPlatform = (page: Page, platform: string) =>
  page.addInitScript((platform) => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform })
  }, platform)

const captureHostLabel = async (page: Page, filename: string) => {
  const directory = process.env.TOURI_HOSTLABEL_SHOTS
  if (!directory) return

  await page.screenshot({ path: join(directory, filename), animations: "disabled" })
}
