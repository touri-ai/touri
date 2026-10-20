import { expect, test } from "@playwright/test"

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 700 },
  { name: "phone", width: 390, height: 844 },
]

const scenarios = [
  { name: "requester", query: "viewer=user-ana" },
  { name: "member-no-control", query: "viewer=user-hugo&queue=1" },
  { name: "takeover-hidden-preview", query: "viewer=user-hugo&takeover=1" },
]

test.describe("browser card in a channel", () => {
  for (const size of sizes) {
    for (const scenario of scenarios) {
      test(`${scenario.name} at ${size.name}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.goto(`/test/e2e/channel-browser-harness.html?${scenario.query}`)

        await expect(page.getByText("Todos no canal veem")).toBeVisible()
        await expect(page.getByRole("status", { name: "Léo no navegador · pedido de Ana" })).toBeVisible()
        await expect(page.getByTitle("Léo trabalhando aqui")).toBeVisible()
        await expect(page.locator(".composer-browser-status")).toContainText("para Ana")
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow).toBeLessThanOrEqual(0)

        if (scenario.name === "requester") await expect(page.getByRole("button", { name: /Assumir/ })).toBeEnabled()
        if (scenario.name !== "requester") await expect(page.getByRole("button", { name: /Assumir/ })).toBeDisabled()
        if (scenario.name === "takeover-hidden-preview")
          await expect(page.getByText("Prévia oculta para o canal enquanto Ana digita")).toBeVisible()
        if (scenario.name === "member-no-control") await expect(page.getByText("Na fila: pedido de Hugo")).toBeVisible()

        await page.screenshot({
          path: testInfo.outputPath(`channel-${scenario.name}-${size.name}.png`),
          fullPage: true,
        })
      })
    }
  }
})
