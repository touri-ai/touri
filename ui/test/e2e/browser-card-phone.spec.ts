import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" })

test("phone browser controls have usable touch targets and actions keep a stable card", async ({ page }, info) => {
  test.setTimeout(120_000)
  await page.goto("/test/e2e/browser-activity-harness.html?theme=light")
  await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
  const card = page.locator(".browser-activity-card")
  await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
  const getScreenshotPath = (name: string) =>
    process.env.TOURI_E2E_EVIDENCE_DIR ? join(process.env.TOURI_E2E_EVIDENCE_DIR, name) : info.outputPath(name)
  const controls = card.locator(".browser-activity-header-actions button")

  for (const button of await controls.all()) {
    const bounds = await button.boundingBox()
    expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44)
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  const initial = await card.boundingBox()
  const log = card.getByRole("log")
  await expect(log).toHaveCSS("height", "156px")
  await page.screenshot({ path: getScreenshotPath("phone-card-initial.png"), fullPage: true })

  await page.getByRole("textbox", { name: "Destino" }).fill("Lisboa")
  await page.getByRole("option", { name: "Lisboa, Portugal" }).click()
  await page.getByLabel("Cabine").selectOption("economy")
  await page.getByRole("button", { name: "Abrir calendário de partida" }).click()
  await page.getByRole("button", { name: "Data de partida 24 de outubro" }).click()

  const updated = await card.boundingBox()
  expect(initial).not.toBeNull()
  expect(updated).not.toBeNull()
  expect(Math.abs((updated?.height ?? 0) - (initial?.height ?? 0))).toBeLessThanOrEqual(1)
  await expect(log).toHaveCSS("height", "156px")
  await page.screenshot({ path: getScreenshotPath("phone-card-updated.png"), fullPage: true })
})
