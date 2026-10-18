import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`work queue and performance at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize(viewport)
    // Development optimization can reload the page; start with a fresh mock after it settles.
    await page.goto("/test/e2e/work-harness.html")
    await page.waitForLoadState("networkidle")
    await page.reload({ waitUntil: "networkidle" })
    await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
    const startedDocument = await page.evaluate(() => performance.timeOrigin)
    const openAdvanced = async () => {
      if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
      await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    }

    await openAdvanced()
    await page.getByRole("button", { name: "Trabalho", exact: true }).click()

    const running = page.getByRole("region", { name: "Trabalhando", exact: true })
    const queued = page.getByRole("region", { name: "Na fila", exact: true })
    await expect(running.getByRole("article")).toHaveCount(3)
    await expect(queued.getByRole("article")).toHaveCount(2)
    await expect(page.getByText("Na fila · 2º de 2")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/work-queue-${viewport.width}.png` })

    await page.evaluate(() => {
      const fixture = window as Window & { workQa?: { finishFirst: () => void } }
      fixture.workQa?.finishFirst()
    })

    await expect(queued.getByRole("article")).toHaveCount(1, { timeout: 1000 })
    await expect(running.getByRole("article")).toHaveCount(3)
    await expect(page.getByText("Na fila · 1º de 1")).toBeVisible()
    await page.getByRole("button", { name: "Tarefa de organização" }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Organização" })).toBeVisible()
    await expect(page.getByText("Na fila · 1º de 1")).toBeVisible()

    await openAdvanced()
    await page.getByRole("button", { name: "Desempenho", exact: true }).click()
    await page.getByRole("spinbutton", { name: "Tarefas ao mesmo tempo" }).fill("4")
    await page.getByRole("button", { name: "Salvar limite" }).click()
    await expect(page.getByText("Limite salvo.")).toBeVisible()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/work-performance-${viewport.width}.png` })
    await openAdvanced()
    await page.getByRole("button", { name: "Trabalho", exact: true }).click()
    await openAdvanced()
    await page.getByRole("button", { name: "Desempenho", exact: true }).click()
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedDocument)
    await expect(page.getByRole("spinbutton", { name: "Tarefas ao mesmo tempo" })).toHaveValue("4")
  })
}
