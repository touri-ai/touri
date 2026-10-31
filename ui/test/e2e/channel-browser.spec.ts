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
  { name: "requester-observes-waiting-member", query: "viewer=user-ana&queue=1" },
  { name: "takeover-live-preview", query: "viewer=user-hugo&takeover=1" },
]

test.describe("browser card in a channel", () => {
  for (const size of sizes) {
    for (const scenario of scenarios) {
      test(`${scenario.name} at ${size.name}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.goto(`/test/e2e/channel-browser-harness.html?${scenario.query}`)

        await expect(page.getByText("Ao vivo", { exact: true })).toBeVisible()
        const isRequester = scenario.query.includes("viewer=user-ana")
        const requester = isRequester ? "você" : "Ana"
        const control = scenario.name === "takeover-live-preview" ? " · Ana está no controle" : ""
        const header = `Léo no navegador · pedido de ${requester}${control}`
        await expect(page.getByRole("status", { name: header })).toBeVisible()
        await expect(page.getByTitle("Léo trabalhando aqui")).toBeVisible()
        if (scenario.name === "takeover-live-preview")
          await expect(page.locator(".composer-browser-status")).toContainText("Ana está no controle")
        else
          await expect(page.locator(".composer-browser-status")).toContainText(isRequester ? "para você" : "para Ana")
        await expect(
          page.locator(".channel-demo-reply").getByRole("article", { name: "Navegador do Léo" }),
        ).toBeVisible()
        const editGroup = await page.getByRole("button", { name: "Editar grupo" }).boundingBox()
        const replyHeader = await page.locator(".channel-demo-reply .message-meta").boundingBox()
        expect(editGroup).not.toBeNull()
        expect(replyHeader?.y).toBeGreaterThanOrEqual((editGroup?.y ?? 0) + (editGroup?.height ?? 0))
        await expect(page.locator(".browser-activity-chrome")).toContainText("estadias.example.test")
        await expect(page.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow).toBeLessThanOrEqual(0)

        if (size.width <= 600) {
          const preview = await page.locator(".browser-activity-preview").boundingBox()
          const log = await page.locator(".browser-activity-log").boundingBox()
          expect(preview).not.toBeNull()
          expect(log).not.toBeNull()
          expect(log?.y).toBeGreaterThanOrEqual((preview?.y ?? 0) + (preview?.height ?? 0))
        }

        if (isRequester) await expect(page.getByRole("button", { name: "Assumir", exact: true })).toBeEnabled()
        if (!isRequester) {
          await expect(page.getByRole("button", { name: "Assumir", exact: true })).toHaveCount(0)
          if (scenario.name === "takeover-live-preview")
            await expect(page.getByText(/Ana está usando/).first()).toBeVisible()
        }
        if (scenario.name === "takeover-live-preview") await expect(page.getByText(/Ana está usando/)).toBeVisible()
        if (scenario.name === "member-no-control") {
          await expect(page.getByText("Na fila: pedido de você", { exact: true })).toBeVisible()
          await expect(page.getByText("Na fila: pedido de Hugo", { exact: true })).toHaveCount(0)
        }
        if (scenario.name === "requester-observes-waiting-member")
          await expect(page.getByText("Na fila: pedido de Hugo", { exact: true })).toBeVisible()

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
