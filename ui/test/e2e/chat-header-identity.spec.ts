import { expect, test } from "@playwright/test"

for (const width of [390, 1440]) {
  test(`chat identity and bot navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/home-harness.html")
    const header = page.locator(".chat-header")

    await expect(header.getByRole("heading", { name: "mark", exact: true })).toBeVisible()
    await expect(header.locator(".chat-header-crumb")).toHaveText("Bots")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const navigation = page.getByRole("navigation", { name: "Barra lateral" })
    await expect(navigation).toBeVisible()
    await expect(navigation.locator(".bot-list")).toBeVisible()
  })
}
