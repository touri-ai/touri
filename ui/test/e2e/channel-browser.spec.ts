import { join } from "node:path"
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
        const header =
          scenario.name === "takeover-hidden-preview"
            ? "Léo no navegador · pedido de Ana · Ana está no controle"
            : "Léo no navegador · pedido de Ana"
        await expect(page.getByRole("status", { name: header })).toBeVisible()
        await expect(page.getByTitle("Léo trabalhando aqui")).toBeVisible()
        if (scenario.name === "takeover-hidden-preview")
          await expect(page.locator(".composer-browser-status")).toContainText("Ana está no controle")
        else await expect(page.locator(".composer-browser-status")).toContainText("para Ana")
        await expect(
          page.locator(".channel-demo-reply").getByRole("article", { name: "Navegador do Léo" }),
        ).toBeVisible()
        const editGroup = await page.getByRole("button", { name: "Editar grupo" }).boundingBox()
        const replyHeader = await page.locator(".channel-demo-reply .message-meta").boundingBox()
        expect(editGroup).not.toBeNull()
        expect(replyHeader?.y).toBeGreaterThanOrEqual((editGroup?.y ?? 0) + (editGroup?.height ?? 0))
        const visibleUrl = scenario.name === "takeover-hidden-preview" ? 0 : 1
        await expect(
          page.locator(".browser-activity-subtitle").filter({ hasText: "estadias.example.test" }),
        ).toHaveCount(visibleUrl)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow).toBeLessThanOrEqual(0)

        if (size.width <= 600) {
          const preview = await page.locator(".browser-activity-preview").boundingBox()
          const log = await page.locator(".browser-activity-log").boundingBox()
          expect(preview).not.toBeNull()
          expect(log).not.toBeNull()
          expect(log?.y).toBeGreaterThanOrEqual((preview?.y ?? 0) + (preview?.height ?? 0))
        }

        if (scenario.name === "requester") await expect(page.getByRole("button", { name: /Assumir/ })).toBeEnabled()
        if (scenario.name !== "requester") {
          await expect(page.getByRole("button", { name: /Assumir/ })).toHaveCount(0)
          if (scenario.name === "takeover-hidden-preview")
            await expect(page.getByText("Ana está no controle").first()).toBeVisible()
        }
        if (scenario.name === "takeover-hidden-preview")
          await expect(page.getByText("Prévia oculta para o canal enquanto Ana digita")).toBeVisible()
        if (scenario.name === "member-no-control") await expect(page.getByText("Na fila: pedido de Hugo")).toBeVisible()

        const screenshotName = `channel-${scenario.name}-${size.name}.png`
        const evidenceDirectory = process.env.TOURI_E2E_SCREENSHOTS_DIR
        await page.screenshot({
          path: evidenceDirectory ? join(evidenceDirectory, screenshotName) : testInfo.outputPath(screenshotName),
          fullPage: true,
        })
      })
    }
  }
})
