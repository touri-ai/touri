import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const variants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", colorScheme: "dark" as const },
  { name: "desktop-light", width: 1440, height: 900, theme: "light", colorScheme: "light" as const },
  { name: "phone-dark", width: 390, height: 844, theme: "dark", colorScheme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light", colorScheme: "light" as const },
]

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } }, reducedMotion: "reduce" })

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

      const preview = page.getByRole("img", { name: "Página atual do navegador" })
      await expect(preview).toBeVisible()
      const compactWidth = (await preview.boundingBox())?.width ?? 0
      await page.getByRole("button", { name: "Expandir navegador" }).click()
      if (variant.width > 600) expect((await preview.boundingBox())?.width ?? 0).toBeGreaterThan(compactWidth * 1.4)
      await page.getByRole("button", { name: "Recolher navegador" }).click()
      await page.getByRole("button", { name: "Abrir navegador" }).click()
      await expect(page.getByText("Tela do navegador aberta")).toBeVisible()
      const accessibility = await new AxeBuilder({ page }).include(".browser-activity-card").analyze()
      expect(accessibility.violations).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`browser-live-${variant.name}.png`), fullPage: true })

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
      await expect(page.getByText("Atividade do navegador", { exact: true })).toBeVisible()
      await expect(page.getByText("Abriu a página")).toBeVisible()
      await expect(page.getByText("Tirou um print")).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await page.mouse.move(variant.width - 5, variant.height - 5)
      await page.mouse.wheel(0, 2_000)
      await expect(page.getByRole("textbox", { name: "Mensagem", exact: true })).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`browser-activity-${variant.name}.png`), fullPage: true })

      const video = page.video()
      await page.close()
      if (video) await video.saveAs(testInfo.outputPath(`browser-activity-${variant.name}.webm`))
    })
  }
})

for (const fallback of ["missing_key", "no_credit"] as const) {
  for (const locale of ["pt-BR", "en"] as const) {
    test(`browser fallback remains usable: ${fallback} ${locale}`, async ({ page }, testInfo) => {
      const isEnglish = locale === "en"
      await page.goto(`/test/e2e/browser-activity-harness.html?fallback=${fallback}&locale=${locale}`)
      await page.getByRole("button", { name: isEnglish ? "Start travel search" : "Iniciar busca de viagem" }).click()
      await page.getByRole("textbox", { name: isEnglish ? "Destination" : "Destino" }).fill("Lisboa")
      await page.getByRole("option", { name: "Lisboa, Portugal" }).click()
      const englishNotice = {
        missing_key:
          "Assisted browser choices are off or have no saved key. You can enable them in API model settings. The browser will keep working.",
        no_credit: "The browser helper has no credit. Continuing with standard controls.",
      }[fallback]
      const portugueseNotice = {
        missing_key:
          "A ajuda nas escolhas está desativada ou sem chave salva. Você pode ativá-la em Modelos por API. O navegador continuará funcionando.",
        no_credit: "O assistente do navegador está sem crédito. Continuando com os controles padrão.",
      }[fallback]
      const notice = isEnglish ? englishNotice : portugueseNotice
      await expect(page.getByText(notice)).toBeVisible()
      await expect(page.locator("body")).not.toContainText("TOURI_BROWSER_DECISION_HINT")
      const takeOver = page.getByRole("button", { name: isEnglish ? "Take over" : "Assumir controle" })
      await takeOver.focus()
      await page.keyboard.press("Enter")
      const handBack = page.getByRole("button", { name: /Hand back to|Devolver para/ })
      await expect(handBack).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`browser-${fallback}-${locale}.png`), fullPage: true })
      await handBack.click()
      await page.getByRole("button", { name: isEnglish ? "Search trips" : "Buscar viagens" }).click()
      await expect(page.getByRole("button", { name: /Used the browser|Usou o navegador/ })).toBeVisible()
      const video = page.video()
      await page.close()
      if (video) await video.saveAs(testInfo.outputPath(`browser-${fallback}-${locale}.webm`))
    })
  }
}

for (const width of [360, 390, 430, 1440]) {
  test(`finished browser card without an image stays compact at ${width}px`, async ({ page }) => {
    const evidence = resolve(import.meta.dirname, "../../../docs/qa/landing-bugs")
    mkdirSync(evidence, { recursive: true })
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/test/e2e/browser-activity-harness.html?screenshot=none")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    await page.getByRole("button", { name: "Buscar viagens" }).click()
    const summary = page.getByRole("button", { name: /Usou o navegador/ })
    await expect(summary).toBeVisible()
    await expect(summary.locator("img")).toHaveCount(0)
    await page.screenshot({ path: `${evidence}/browser-no-image-${width}.png` })

    expect((await summary.boundingBox())?.height).toBeLessThan(90)
    await expect(summary).toContainText("Ver o que ele fez")
    await summary.click()
    await expect(page.getByText("Atividade do navegador", { exact: true })).toBeVisible()
  })
}
