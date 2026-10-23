import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

for (const width of [1440, 390]) {
  test(`a stalled browser preview offers recovery at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.clock.install()
    await page.goto("/test/e2e/browser-activity-harness.html?previewStall=true")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    await expect(page.getByRole("article", { name: "Navegador do mark" })).toBeVisible()
    await expect.poll(() => page.evaluate(getPreviewRequestCount)).toBeGreaterThan(0)

    await page.clock.fastForward(16_000)

    const retry = page.getByRole("button", { name: "Tentar carregar prévia novamente" })
    await expect(retry).toBeVisible()
    await expect(page.getByText(/Tentando reconectar/)).toHaveCount(0)
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: resolve(directory, `browser-recovery-${width}.png`), fullPage: true })

    await retry.click()

    await expect(retry).toHaveCount(0)
    await expect(page.getByText("Aguardando a página do navegador…")).toBeVisible()
  })
}

const getPreviewRequestCount = () => {
  const fixture = window as Window & { browserActivity?: { snapshot: () => { previewRequests: number } } }

  return fixture.browserActivity?.snapshot().previewRequests ?? 0
}
