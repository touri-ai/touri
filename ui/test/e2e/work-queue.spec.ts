import AxeBuilder from "@axe-core/playwright"
import { expect } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"
import { test } from "./production-fixture"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`queued channel request stays visible at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/work-harness.html?channel-queue")
    await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
    if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await openGlobalPage(page, "Trabalho")
    const waiting = page.locator('[data-run-id="channel-waiting"]')

    await expect(waiting).toContainText("Na fila · aguardando o bot concluir o pedido anterior")
    await expect(page.getByRole("region", { name: "Trabalhando", exact: true }).getByRole("article")).toHaveCount(1)
    expect(
      (await new AxeBuilder({ page }).include(".work-screen").withTags(["wcag2a", "wcag2aa"]).analyze()).violations,
    ).toEqual([])
    await page.emulateMedia({ colorScheme: "light" })
    expect(
      (await new AxeBuilder({ page }).include(".work-screen").withTags(["wcag2a", "wcag2aa"]).analyze()).violations,
    ).toEqual([])
    await page.emulateMedia({ colorScheme: "dark" })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/channel-waiting-${viewport.width}.png` })

    await waiting.getByRole("button", { name: "Equipe de demonstração", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Equipe de demonstração" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/channel-conversation-${viewport.width}.png` })
    if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await openGlobalPage(page, "Trabalho")

    await page.evaluate(() => {
      const fixture = window as Window & { workQa?: { finishFirst: () => void } }
      fixture.workQa?.finishFirst()
    })

    await expect(waiting).toHaveCount(0)
    await expect(page.locator('[data-run-id="channel-execution"]')).toBeVisible()
    await expect(page.getByRole("region", { name: "Trabalhando", exact: true }).getByRole("article")).toHaveCount(1)
    await expect(page.getByRole("region", { name: "Na fila", exact: true }).getByRole("article")).toHaveCount(0)
  })

  test(`stop a blocking task without canceling its waiting request at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/work-harness.html?channel-queue")
    await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
    if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    await page.getByRole("button", { name: "Trabalho", exact: true }).click()
    const active = page.locator('[data-run-id="work-run-0"]')
    const waiting = page.locator('[data-run-id="channel-waiting"]')

    await expect(waiting.getByRole("button", { name: "Cancelar só este pedido" })).toBeVisible()
    const stopButton = active.getByRole("button", { name: "Parar só esta tarefa" })
    await expect(stopButton).toBeVisible()
    const target = await stopButton.boundingBox()
    expect(target?.height).toBeGreaterThanOrEqual(viewport.width === 390 ? 44 : 40)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/task-stop-${viewport.width}.png` })

    await active.getByRole("button", { name: "Parar só esta tarefa" }).click()

    await expect(active).toHaveCount(0)
    await expect(waiting).toHaveCount(0)
    await expect(page.locator('[data-run-id="channel-execution"]')).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/task-started-${viewport.width}.png` })
  })

  test(`work queue and performance at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/work-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
    const startedDocument = await page.evaluate(() => performance.timeOrigin)
    const openAdvanced = async () => {
      if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    }

    await openAdvanced()
    await openGlobalPage(page, "Trabalho")

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
    await openGlobalPage(page, "Desempenho")
    await page.getByRole("spinbutton", { name: "Tarefas ao mesmo tempo" }).fill("4")
    await page.getByRole("button", { name: "Salvar limite" }).click()
    await expect(page.getByText("Limite salvo.")).toBeVisible()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/work-performance-${viewport.width}.png` })
    await openAdvanced()
    await openGlobalPage(page, "Trabalho")
    await openAdvanced()
    await openGlobalPage(page, "Desempenho")
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedDocument)
    await expect(page.getByRole("spinbutton", { name: "Tarefas ao mesmo tempo" })).toHaveValue("4")
  })
}
