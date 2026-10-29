import { readFile } from "node:fs/promises"
import { expect, type Locator, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"

test.use({ locale: "pt-BR", reducedMotion: "reduce" })
test.setTimeout(60_000)

type NotificationFixtureWindow = Window & { workspaceQa: { api: ReturnType<typeof createMockApi> } }

const scenarios = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
].flatMap(({ width, height }) => (["light", "dark"] as const).map((theme) => ({ width, height, theme })))

scenarios.forEach(({ width, height, theme }) => {
  test(`sidebar notification bell stays 16x16 with and without a pending count at ${width}x${height} (${theme})`, async ({
    page,
  }) => {
    const buttonStyles = await readFile(new URL("../../src/components/ds.css", import.meta.url), "utf8")
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
    await page.goto("/test/e2e/home-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const sidebar = page.getByRole("navigation", { name: "Barra lateral", exact: true })
    const bell = sidebar.getByRole("button", { name: /^Notificações/ })
    const badge = bell.locator(".notification-badge")

    // Shared button CSS can load after the app stylesheet in production.
    await page.addStyleTag({ content: buttonStyles })

    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    await expect(bell).toBeVisible()
    const targetBounds = await bell.boundingBox()
    const minimum = width === 390 ? 44 : 40
    expect(targetBounds?.width).toBeGreaterThanOrEqual(minimum)
    expect(targetBounds?.height).toBeGreaterThanOrEqual(minimum)
    await expect(badge).toHaveText("1")
    await expect(badge).toHaveCSS("position", "absolute")
    await expect.poll(() => getIconGeometry(bell)).toEqual({ width: 16, height: 16, centerX: 0, centerY: 0 })
    const badgeGeometry = await getBadgeGeometry(badge)
    expect(badgeGeometry.top).toBeGreaterThanOrEqual(0)
    expect(badgeGeometry.top).toBeLessThanOrEqual(4)
    expect(badgeGeometry.right).toBeGreaterThanOrEqual(0)
    expect(badgeGeometry.right).toBeLessThanOrEqual(4)

    await page.evaluate(async () => {
      const fixture = window as NotificationFixtureWindow

      await fixture.workspaceQa.api.request("POST /notifications/dismiss-all", {})
    })

    await expect(bell).toHaveAccessibleName("Notificações")
    await expect(badge).toHaveCount(0)
    await expect.poll(() => getIconGeometry(bell)).toEqual({ width: 16, height: 16, centerX: 0, centerY: 0 })
  })
})

const getIconGeometry = (bell: Locator) =>
  bell.evaluate((button) => {
    const icon = button.querySelector("svg")
    if (!icon) throw new Error("Missing notification bell icon")

    const buttonBounds = button.getBoundingClientRect()
    const iconBounds = icon.getBoundingClientRect()

    return {
      width: iconBounds.width,
      height: iconBounds.height,
      centerX: iconBounds.x + iconBounds.width / 2 - buttonBounds.x - buttonBounds.width / 2,
      centerY: iconBounds.y + iconBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2,
    }
  })

const getBadgeGeometry = (badge: Locator) =>
  badge.evaluate((element) => {
    const button = element.parentElement
    if (!button) throw new Error("Missing notification bell button")

    const buttonBounds = button.getBoundingClientRect()
    const badgeBounds = element.getBoundingClientRect()

    return { top: badgeBounds.top - buttonBounds.top, right: buttonBounds.right - badgeBounds.right }
  })
