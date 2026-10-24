import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ locale: "pt-BR", reducedMotion: "reduce" })

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]
viewports.forEach(({ width, height }) => {
  test(`clearing information preserves approvals and recovery actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto("/test/e2e/notification-read-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width < 600) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Notificações, / }).click()
    const center = page.getByRole("region", { name: "Central de notificações" })
    await expect(center.getByText("Resumo fictício", { exact: true })).toBeVisible()

    const directory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (directory) {
      await mkdir(directory, { recursive: true })
      await center.screenshot({ path: join(directory, `notification-read-before-${width}.png`) })
    }

    await center.getByRole("button", { name: "Limpar", exact: true }).click()

    await expect(center.getByText("Resumo fictício", { exact: true })).toHaveCount(0)
    await expect(center.getByText("Informação fictícia", { exact: true })).toHaveCount(0)
    await expect(center.getByRole("button", { name: "Abrir e revisar", exact: true })).toBeVisible()
    await expect(center.getByRole("button", { name: "Tarefas interrompidas", exact: true })).toBeVisible()
    await expect(center.getByRole("status")).toHaveText("Notificações que ainda precisam de atenção: 4.")
    await expect(center.getByTestId("notification-row")).toHaveCount(4)
    if (directory) await center.screenshot({ path: join(directory, `notification-read-after-${width}.png`) })
    expect(await page.evaluate(() => localStorage.getItem("touri.notifications.cleared.v1"))).toBeNull()
    expect(await center.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })
})
