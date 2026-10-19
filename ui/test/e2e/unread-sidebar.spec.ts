import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const output = "../docs/qa/unread-sidebar"
const themes = ["light", "dark"]
const layouts = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]

layouts.forEach(({ name, width, height }) => {
  themes.forEach((theme) => {
    test(`unread sidebar: ${name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.clock.setFixedTime(new Date("2026-10-19T12:00:00Z"))
      await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
      await page.goto("/")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      if (name === "mobile") await page.getByRole("button", { name: "Abrir menu" }).click()
      const sidebar = page.getByRole("navigation", { name: "Barra lateral" })
      const mark = sidebar.locator('[data-bot-entry="bot-mark"]')
      await page.evaluate(() => document.fonts.ready)

      await expect(mark.locator(".bot-row .sidebar-unread")).toHaveCount(0)
      await expect(mark.getByRole("img", { name: "2 mensagens não lidas" })).toBeVisible()
      await mkdir(output, { recursive: true })
      await sidebar.screenshot({ path: `${output}/expanded-${name}-${theme}.png` })

      await sidebar.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
      await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
      if (name === "mobile") await page.getByRole("button", { name: "Abrir menu" }).click()

      await expect(mark.locator(".bot-thread-tree")).toHaveCount(0)
      await expect(mark.getByRole("img", { name: "2 mensagens não lidas" })).toBeVisible()
      await sidebar.screenshot({ path: `${output}/collapsed-${name}-${theme}.png` })
    })
  })
})
