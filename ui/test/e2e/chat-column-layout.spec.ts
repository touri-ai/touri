import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import { showBotChat, showWorkMode } from "./home-navigation"

test.use({ reducedMotion: "reduce" })
test.setTimeout(90_000)

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"]) {
    test(`chat uses the available pane at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.goto(`/test/e2e/explicit-threads-harness.html?theme=${theme}`)
      await showWorkMode(page)
      await page.locator('[data-work-bot-entry="bot-mark"] .bot-row-main').click()
      await expect(page.locator(".message-bubble").first()).toBeVisible()
      await checkColumn(page, info, `direct-${width}-${theme}`)

      await showWorkMode(page)
      await showBotChat(page)
      await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
      await checkColumn(page, info, `bot-${width}-${theme}`)

      await showWorkMode(page)
      await page.getByRole("button", { name: /^Planejamento(?:,|$)/ }).click()
      const message = page.locator('[data-message-row="thread-demo-request"]')
      await expect(message).toBeVisible()
      await checkColumn(page, info, `channel-${width}-${theme}`)

      await message.getByRole("button", { name: "Iniciar thread", exact: true }).focus()
      await page.keyboard.press("Enter")
      await expect(page.locator('[data-message-row="context-thread-demo-request"]')).toBeVisible()
      await checkColumn(page, info, `thread-${width}-${theme}`)
    })
  }
}

const checkColumn = async (page: Page, info: TestInfo, screen: string) => {
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
  const phase = process.env.CHAT_COLUMN_PHASE ?? "after"
  const filename = `${phase}-${screen}.png`
  const directory = process.env.CHAT_COLUMN_EVIDENCE_DIR
  const path = directory ? join(directory, filename) : info.outputPath(filename)
  await page.screenshot({ path, animations: "disabled" })
  await info.attach(filename, { path, contentType: "image/png" })

  const geometry = await page.locator(".message-scroll").evaluate((scroll) => {
    const row = scroll.querySelector(".message-bubble")
    if (!row) throw new Error("Expected a visible conversation message")

    const style = getComputedStyle(scroll)
    const bounds = scroll.getBoundingClientRect()
    const message = row.getBoundingClientRect()
    const paddingLeft = Number.parseFloat(style.paddingLeft)
    const paddingRight = Number.parseFloat(style.paddingRight)

    return {
      inset: message.left - bounds.left - scroll.clientLeft - paddingLeft,
      unusedWidth: scroll.clientWidth - paddingLeft - paddingRight - message.width,
      overflow: scroll.scrollWidth - scroll.clientWidth,
    }
  })
  const panel = await page.locator(".chat-panel").boundingBox()
  const composer = await page.locator(".composer").boundingBox()
  if (!panel || !composer) throw new Error("Expected a conversation and composer")

  expect.soft(Math.abs(geometry.inset), `${screen}: message starts at the pane padding`).toBeLessThanOrEqual(1)
  expect.soft(Math.abs(geometry.unusedWidth), `${screen}: message uses the available width`).toBeLessThanOrEqual(1)
  expect.soft(geometry.overflow, `${screen}: history has no horizontal overflow`).toBeLessThanOrEqual(1)
  expect
    .soft(composer.x - panel.x, `${screen}: composer has only its responsive gutter`)
    .toBeCloseTo(page.viewportSize()?.width === 390 ? 12 : 24, 0)
  expect
    .soft(panel.x + panel.width - composer.x - composer.width)
    .toBeCloseTo(page.viewportSize()?.width === 390 ? 12 : 24, 0)
  const accessibility = await new AxeBuilder({ page }).include(".chat-panel").analyze()

  expect.soft(accessibility.violations).toEqual([])
  await info.attach(`${screen}-geometry`, { body: JSON.stringify(geometry), contentType: "application/json" })
}
