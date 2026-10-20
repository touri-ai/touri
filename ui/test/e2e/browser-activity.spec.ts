import { expect, test } from "@playwright/test"

const variants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", colorScheme: "dark" as const },
  { name: "desktop-light", width: 1440, height: 900, theme: "light", colorScheme: "light" as const },
  { name: "phone-dark", width: 390, height: 844, theme: "dark", colorScheme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light", colorScheme: "light" as const },
]

test.use({ video: "on", reducedMotion: "reduce" })

test.describe("browser activity experience", () => {
  test.setTimeout(60_000)

  for (const variant of variants) {
    test(`local search, takeover and final browser card: ${variant.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: variant.width, height: variant.height })
      await page.emulateMedia({ colorScheme: variant.colorScheme })
      await page.goto(`/test/e2e/browser-activity-harness.html?theme=${variant.theme}`)

      await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
      await expect(page.locator(".composer-browser-status")).toContainText("está trabalhando · No navegador")
      await page.getByRole("textbox", { name: "Destino" }).fill("Lisboa")
      await page.getByRole("option", { name: "Lisboa, Portugal" }).click()
      await page.getByLabel("Cabine").selectOption("economy")
      await page.getByRole("button", { name: "Abrir calendário de partida" }).click()
      await page.getByRole("button", { name: "Data de partida 24 de outubro" }).click()
      await expect(page.getByRole("status").filter({ hasText: "Confiança do JEV: 96%" })).toBeVisible()

      const takeOver = page.getByRole("button", { name: "Assumir controle" })
      await expect(takeOver).toBeVisible()
      await takeOver.click()
      await expect(page.getByText("Tela do navegador aberta")).toBeVisible()
      const search = page.getByRole("button", { name: "Buscar viagens" })
      await expect(search).toBeDisabled()
      await expect(page.getByText("Resultados da busca")).toHaveCount(0)
      await page.getByRole("button", { name: /Devolver para/ }).click()
      await expect(search).toBeEnabled()
      await search.click()

      await expect(page.getByRole("heading", { name: "Resultados da busca" })).toBeVisible()
      await expect(page.getByText("Lisboa · direto · viagem fictícia")).toBeVisible()
      const finalScreenshot = await page.evaluate(() => {
        const fixture = (
          window as Window & {
            browserActivity?: {
              snapshot: () => { parts: Array<{ outputAttachmentId?: string }>; attachmentRead: boolean }
            }
          }
        ).browserActivity
        return {
          attachmentId: fixture?.snapshot().parts.at(-1)?.outputAttachmentId,
          attachmentRead: fixture?.snapshot().attachmentRead,
        }
      })
      expect(finalScreenshot).toEqual({ attachmentId: "browser-final-screenshot", attachmentRead: true })
      const summary = page.getByRole("button", { name: /Usou o navegador/ })
      await expect(summary).toBeVisible()
      await expect(summary.getByRole("img", { name: "Captura final do navegador" })).toBeVisible()
      await summary.click()
      await expect(page.getByRole("heading", { name: "Atividade do navegador" })).toBeVisible()
      await expect(page.getByText("Abriu a página")).toBeVisible()
      await expect(page.getByText("Tirou um print")).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: testInfo.outputPath(`browser-activity-${variant.name}.png`), fullPage: true })

      const video = page.video()
      await page.close()
      if (video) await video.saveAs(testInfo.outputPath(`browser-activity-${variant.name}.webm`))
    })
  }
})
