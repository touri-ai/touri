import { mkdir, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, type TestInfo, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.describe.configure({ timeout: 60_000 })

const productionDirectory = resolve(import.meta.dirname, "../../dist")

test.beforeEach(async ({ context }) => {
  // Audit the compiled app, including its lazy browser controls, without development transforms.
  await context.route("**/test/e2e/channel-takeover-harness.html*", (route) =>
    route.fulfill({ path: join(productionDirectory, "test/e2e/channel-takeover-harness.html") }),
  )
  await context.route("**/assets/*", (route) =>
    route.fulfill({ path: join(productionDirectory, "assets", basename(new URL(route.request().url()).pathname)) }),
  )
})

const views = ["channel", "direct"].flatMap((surface) => [1440, 390].map((width) => ({ surface, width })))

for (const { surface, width } of views) {
  test(`browser handoff remains usable and accessible in ${surface} at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`/test/e2e/channel-takeover-harness.html?direct=${surface === "direct"}&streaming=true`)
    const composer = page.getByRole("textbox", {
      name: surface === "direct" ? "Mensagem para Planejamento" : "Mensagem para Equipe de viagens",
    })
    const card = page.locator(".browser-activity-card")

    await composer.fill("@Planejamento confira o portal de demonstração e me chame para entrar.")
    await composer.press("Enter")
    await expect(card).toHaveCount(1)
    await expect(card.getByRole("button", { name: "Assumir", exact: true })).toBeVisible()
    await saveScreenshot(page, info, `after-${surface}-waiting-${width}.png`)

    await card.getByRole("button", { name: "Assumir", exact: true }).click()

    const control = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(control).toBeVisible()
    await expect(control.getByRole("button", { name: "Devolver para Planejamento" })).toBeVisible()
    await expect(control.locator("canvas:visible, img").first()).toBeVisible()
    await page.evaluate(() => (window as Window & { completeWaitingReply?: () => void }).completeWaitingReply?.())

    await expect(control.getByRole("button", { name: "Devolver para Planejamento" })).toBeVisible()
    await expect(card).toHaveCount(1)
    await saveScreenshot(page, info, `after-${surface}-control-${width}.png`)
    await expectAccessibleCard(page)
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      const keyboard = control.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
      const contrast = await keyboard.evaluate(getTextContrast)

      console.log(JSON.stringify({ surface, width, theme, keyboardContrast: contrast }))
      expect(contrast).toBeGreaterThanOrEqual(4.5)
      await expectAccessibleCard(page)
      await saveScreenshot(page, info, `after-${surface}-control-${theme}-${width}.png`)
    }

    await control.getByRole("button", { name: "Devolver para Planejamento" }).click()
    await page.evaluate(() => (window as Window & { completeChannelResume?: () => void }).completeChannelResume?.())

    await expect(control).toHaveCount(0)
    await expect(card).toHaveCount(1)
    await expect(card).toContainText("Usou o navegador · 3 ações")
    await expect(
      page
        .getByTestId("virtual-message-list")
        .getByText("O portal de demonstração está pronto para continuar.", { exact: true }),
    ).toBeVisible()
    await expectAccessibleCard(page)
    await saveScreenshot(page, info, `after-${surface}-resumed-${width}.png`)
  })

  test(`browser expiry is visibly incomplete and accessible in ${surface} at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/test/e2e/channel-takeover-harness.html?direct=${surface === "direct"}&streaming=true`)
    const composer = page.getByRole("textbox", {
      name: surface === "direct" ? "Mensagem para Planejamento" : "Mensagem para Equipe de viagens",
    })
    await composer.fill("@Planejamento confira o portal de demonstração e me chame para entrar.")
    await composer.press("Enter")
    await expect(page.locator(".browser-activity-card")).toBeVisible()

    await page.evaluate(() => (window as Window & { completeWaitingReply?: () => void }).completeWaitingReply?.())
    await page.evaluate(() => (window as Window & { expireChannelHandoff?: () => void }).expireChannelHandoff?.())

    await expect(page.locator(".browser-run-state")).toHaveText("não concluído")
    await expect(page.getByText("Ninguém assumiu a tempo. Peça de novo quando puder.", { exact: true })).toBeVisible()
    await expectAccessibleCard(page)
    await saveScreenshot(page, info, `after-${surface}-expired-${width}.png`)
  })
}

const expectAccessibleCard = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page })
    .include(".browser-activity-card, .browser-takeover-view, .browser-run-state, .chat-terminal-status")
    .analyze()

  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

const getTextContrast = (element: Element): number => {
  const style = getComputedStyle(element)
  const getLuminance = (color: string): number => {
    const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
      const channel = Number(value) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return channels.reduce((sum, channel, index) => sum + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0)
  }
  const foreground = getLuminance(style.color)
  const background = getLuminance(style.backgroundColor)
  // A transparent keyboard field must not composite away its theme's text contrast.
  if (Number(style.opacity) !== 1) return 1

  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
}

const saveScreenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  if (process.env.TOURI_E2E_SKIP_SCREENSHOTS === "1") return

  const screenshot = await page.screenshot({
    fullPage: true,
    animations: "disabled",
    mask: [page.locator(".model-picker-trigger-label")],
    maskColor: "#dddde2",
  })
  await writeFile(info.outputPath(name), screenshot)
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), screenshot)
}
