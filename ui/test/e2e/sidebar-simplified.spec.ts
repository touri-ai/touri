import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

const scenarios = [1440, 1024, 390].flatMap((width) => ["light", "dark"].map((theme) => ({ width, theme })))

scenarios.forEach(({ width, theme }) => {
  test(`bot selection stays flat and channel controls fit at ${width}px in ${theme}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "bots"))
    await page.goto("/test/e2e/work-mode-harness.html?rich")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
    const controlsBefore = await sidebar.getByRole("button").count()

    await page.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()

    await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await expect(sidebar.getByRole("button")).toHaveCount(controlsBefore)
    await expect(sidebar.locator(".bot-thread-tree")).toHaveCount(0)
    const botRow = sidebar.locator('[data-bot-entry="bot-onb"] .bot-row')
    expect((await botRow.boundingBox())?.height).toBeLessThanOrEqual(56)
    await capture(page, `bots-${width}-${theme}`)

    await page.getByRole("tab", { name: /^Work,/ }).click()
    const channel = sidebar.getByRole("button", { name: /^Planejamento/ })
    const row = channel.locator("..")
    const geometry = await row.evaluate((element) => {
      const hash = element.querySelector(".channel-hash")?.getBoundingClientRect()
      const name = element.querySelector(".channel-name")?.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      if (!hash || !name) throw new Error("Missing channel row")

      return {
        centerDifference: Math.abs(hash.y + hash.height / 2 - name.y - name.height / 2),
        nameWithinRow: name.y >= bounds.y && name.bottom <= bounds.bottom,
      }
    })

    expect(geometry.centerDifference).toBeLessThanOrEqual(2)
    expect(geometry.nameWithinRow).toBe(true)
    await expect(sidebar.locator(".channel-bot-avatars")).toHaveCount(0)
    const sidebarContrast = await new AxeBuilder({ page })
      .include(".bot-sidebar")
      .withRules(["color-contrast"])
      .analyze()
    expect(sidebarContrast.violations).toEqual([])
    await capture(page, `work-${width}-${theme}`)
    await channel.click()
    const header = page.locator(".group-header")

    await expect(header.getByRole("button")).toHaveCount(2)
    await expect(header.locator(".chat-header-crumb")).toHaveCount(0)
    expect(await header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0)
    const channelContrast = await new AxeBuilder({ page })
      .include(".group-header")
      .include(".composer")
      .withRules(["color-contrast"])
      .analyze()
    expect(channelContrast.violations).toEqual([])
    await capture(page, `channel-${width}-${theme}`)
    if (width !== 390) return

    const targets = await header.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect()

        return bounds.width >= 44 && bounds.height >= 44
      }),
    )
    expect(targets.every(Boolean)).toBe(true)
  })
})

const capture = async (page: Page, name: string): Promise<void> => {
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(directory, `after-${name}.png`), animations: "disabled" })
}
