import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"

type RecoveryWindow = Window & {
  previewRecovery?: {
    interrupt: () => void
    reconnect: () => void
    finish: () => void
    snapshot: () => { captures: number }
  }
  previewMetrics?: { observer: PerformanceObserver; longTasks: number[]; shifts: number[] }
}

const openWorkChannel = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("button", { name: /^Viagens/ }).click()
  const sidebar = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  if (await sidebar.isVisible()) await page.keyboard.press("Escape")
}

const measureModeSwitches = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (await menu.isVisible()) await menu.click()
  // Warm the same panels before observing steady-state mode switches.
  await page.getByRole("tab", { name: /^Bots,/ }).click()
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.evaluate(() => {
    const metrics = { longTasks: [] as number[], shifts: [] as number[], observer: new PerformanceObserver(() => {}) }
    metrics.observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (entry.entryType === "longtask") metrics.longTasks.push(entry.duration)
      })
    })
    metrics.observer.observe({ type: "longtask" })
    Object.assign(window, { previewMetrics: metrics })
  })
  const samples = await Array.from({ length: 20 }).reduce<Promise<number[]>>(async (pending, index) => {
    const previous = await pending
    const mode = index % 2 === 0 ? "Bots" : "Work"
    const duration = await page.getByRole("tab", { name: new RegExp(`^${mode},`) }).evaluate((element) => {
      const started = performance.now()
      const button = element as HTMLButtonElement
      button.click()

      return new Promise<number>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started))),
      )
    })

    return previous.concat(duration)
  }, Promise.resolve([]))
  const sidebar = page.getByRole("dialog", { name: "Barra lateral", exact: true })
  if (await sidebar.isVisible()) await page.keyboard.press("Escape")

  const tasks = await page.evaluate(() => {
    const metrics = (window as RecoveryWindow).previewMetrics
    metrics?.observer.disconnect()

    return metrics?.longTasks ?? []
  })

  return {
    modeP95Ms: samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? 0,
    modeLongTasksOver50Ms: tasks.filter((duration) => duration > 50).length,
    modeMaxLongTaskMs: Math.max(0, ...tasks),
  }
}

test.use({ reducedMotion: "reduce", colorScheme: "light" })

for (const width of [390, 1440]) {
  test(`Work channel preview survives navigation, capture interruption and reconnect at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/preview-recovery-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para Léo", exact: true })).toBeVisible()
    await openWorkChannel(page)
    const modeMetrics = await measureModeSwitches(page)
    const composer = page.getByRole("textbox", { name: "Mensagem para Viagens", exact: true })
    await composer.fill("@Léo confira a página de demonstração.")
    await composer.press("Enter")
    const card = page.getByRole("article", { name: "Navegador do Léo" })
    const image = card.getByRole("img", { name: "Página atual do navegador" })
    await expect(image).toBeVisible()
    const imageBounds = await image.boundingBox()
    const previewBounds = await card.locator(".browser-activity-preview-frames").boundingBox()

    expect(imageBounds).not.toBeNull()
    expect(previewBounds).not.toBeNull()
    expect(imageBounds?.height ?? Number.POSITIVE_INFINITY).toBeCloseTo(previewBounds?.height ?? 0, 1)

    await image.scrollIntoViewIfNeeded()
    await expect(image).toBeInViewport({ ratio: 0.95 })
    const initialBounds = await card.boundingBox()
    await page.evaluate(() => {
      const records = { longTasks: [] as number[], shifts: [] as number[] }
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
          if (entry.entryType === "longtask") records.longTasks.push(entry.duration)
          if (entry.entryType === "layout-shift" && !shift.hadRecentInput) records.shifts.push(shift.value)
        })
      })
      observer.observe({ type: "longtask" })
      observer.observe({ type: "layout-shift" })
      Object.assign(window, { previewMetrics: Object.assign(records, { observer }) })
    })
    const original = await image.getAttribute("src")

    await page.evaluate(() => (window as RecoveryWindow).previewRecovery?.interrupt())
    await expect
      .poll(() => page.evaluate(() => (window as RecoveryWindow).previewRecovery?.snapshot().captures ?? 0))
      .toBeGreaterThan(1)
    if (await image.count())
      await image.evaluate((element) =>
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
      )
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    const phase = process.env.TOURI_PREVIEW_PHASE ?? "after"
    await page.screenshot({
      path: join(directory, `${phase}-preview-${width}.png`),
      animations: "disabled",
      mask: [page.locator(".composer-model")],
    })

    const snapshotMetrics = await page.evaluate(() => {
      const metrics = (window as RecoveryWindow).previewMetrics

      return {
        longTasksOver50Ms: metrics?.longTasks.filter((duration) => duration > 50).length ?? 0,
        maxLongTaskMs: Math.max(0, ...(metrics?.longTasks ?? [])),
        previewCls: metrics?.shifts.reduce((sum, value) => sum + value, 0) ?? 0,
      }
    })
    console.log(JSON.stringify({ width, phase, ...modeMetrics, ...snapshotMetrics }))

    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute("src", original ?? "")
    const interruptedBounds = await card.boundingBox()
    expect(Math.abs((interruptedBounds?.height ?? 0) - (initialBounds?.height ?? 0))).toBeLessThanOrEqual(1)
    await expect(card.getByText("Reconectando a prévia do navegador…")).toBeVisible()
    await expect(card.getByText("Prévia do navegador indisponível. Abra o navegador para reconectar.")).toHaveCount(0)

    await page.evaluate(() => (window as RecoveryWindow).previewRecovery?.reconnect())

    await expect(image).toBeVisible()
    await expect(image).not.toHaveAttribute("src", original ?? "")
    await expect(card.getByText("Reconectando a prévia do navegador…")).toHaveCount(0)
    await expect(composer).toBeEnabled()
    const metrics = await page.evaluate(() => {
      const metrics = (window as RecoveryWindow).previewMetrics
      metrics?.observer.disconnect()

      return { longTasks: metrics?.longTasks ?? [], cls: metrics?.shifts.reduce((sum, value) => sum + value, 0) ?? 0 }
    })
    console.log(
      JSON.stringify({
        width,
        ...modeMetrics,
        longTasksOver50Ms: metrics.longTasks.filter((duration) => duration > 50).length,
        maxLongTaskMs: Math.max(0, ...metrics.longTasks),
        previewCls: metrics.cls,
      }),
    )
    await info.attach("preview-recovery-metrics", {
      body: JSON.stringify({ width, ...modeMetrics, ...metrics }),
      contentType: "application/json",
    })
    expect(modeMetrics.modeP95Ms).toBeLessThan(100)
    expect(modeMetrics.modeLongTasksOver50Ms).toBe(0)
    expect(metrics.cls).toBeLessThan(0.001)
    await page.evaluate(() => (window as RecoveryWindow).previewRecovery?.finish())
    await expect(page.getByText("Página conferida com sucesso.")).toBeVisible()
    await expect(page.locator(".composer-browser-status")).toHaveCount(0)
  })
}
