import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Locator, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

type TakeoverWindow = Window & {
  completeWaitingReply?: () => void
  completeChannelResume?: () => void
  getChannelTakeoverState?: () => {
    previewRequests: number
    privateInputs: number
    status: string | undefined
    notificationResolved: boolean
  }
  getTakeoverPerformance?: () => { longTasks: number[]; cls: number }
  nextTakeoverInteraction?: Promise<number>
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Work channel takeover survives turn completion and resumes with a live page at ${viewport.width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/channel-takeover-harness.html?work=true&streaming=true&legacyTakeoverNotice=true")
    const composer = page.getByRole("textbox", { name: "Mensagem para Equipe de viagens" })
    await expect(composer).toBeVisible()
    // Warm both modes before collecting interaction and layout measurements.
    for (const mode of ["Bots", "Work"]) {
      if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await page.getByRole("tab", { name: new RegExp(`^${mode},`) }).click()
      if (viewport.width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
    }
    await expect(composer).toBeVisible()
    await page.evaluate(() => {
      // These bounded collectors belong to this measurement and are discarded with the page.
      const longTasks: number[] = []
      const shifts: number[] = []
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (entry.entryType === "longtask") longTasks.push(entry.duration)
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
          if (entry.entryType === "layout-shift" && !shift.hadRecentInput) shifts.push(shift.value ?? 0)
        })
      })
      observer.observe({ entryTypes: ["longtask", "layout-shift"] })
      const fixture = window as TakeoverWindow
      fixture.getTakeoverPerformance = () => ({ longTasks, cls: shifts.reduce((total, value) => total + value, 0) })
    })
    // Keep the local timing samples in input order while switching modes sequentially.
    const interactionMs: number[] = []
    for (const mode of Array.from({ length: 6 }).flatMap(() => ["Bots", "Work"])) {
      if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      interactionMs.push(await measureInteraction(page.getByRole("tab", { name: new RegExp(`^${mode},`) })))
      if (viewport.width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
    }
    await expect(composer).toBeVisible()
    const performance = await page.evaluate(() => (window as TakeoverWindow).getTakeoverPerformance?.())
    if (process.env.TOURI_E2E_EVIDENCE_DIR) {
      await mkdir(process.env.TOURI_E2E_EVIDENCE_DIR, { recursive: true })
      await writeFile(
        join(process.env.TOURI_E2E_EVIDENCE_DIR, `mode-metrics-${viewport.width}.json`),
        JSON.stringify({ viewport, interactionMs, p95Ms: getP95(interactionMs), performance }),
      )
    }
    const screenshot = async (state: string): Promise<void> => {
      const directory = process.env.TOURI_E2E_EVIDENCE_DIR
      if (!directory) return

      await mkdir(directory, { recursive: true })
      await page.screenshot({ path: join(directory, `${state}-${viewport.width}.png`), animations: "disabled" })
    }

    await composer.fill("@Planejamento confira o portal de demonstração e me chame para entrar.")
    await composer.press("Enter")
    const card = page.locator(".browser-activity-card").first()
    const takeover = card.getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeVisible()
    await expect(page.locator(".channel-chip")).toContainText("Planejamento no navegador")
    const waitingStatus = await page.locator(".composer-browser-status").textContent()
    await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
    const liveWhileWaiting = await card.getByRole("img", { name: "Página atual do navegador" }).count()
    const previewRequests = await page.evaluate(
      () => (window as TakeoverWindow).getChannelTakeoverState?.().previewRequests,
    )
    await screenshot("waiting")
    const groupPanelCount = await page.locator(".group-panel").count()

    interactionMs.push(await measureInteraction(takeover))

    const control = page.getByRole("region", { name: "Controle remoto do navegador" })
    const handback = control.getByRole("button", { name: "Devolver para Planejamento" })
    await expect(control).toContainText("você está usando")
    await expect(handback).toBeInViewport()
    await expect(control.getByRole("status", { name: "Privacidade do navegador" })).toBeInViewport()
    const headingWidth = await control.locator(".browser-activity-heading").evaluate((element) => element.clientWidth)
    expect(headingWidth).toBeGreaterThanOrEqual(180)
    const reason = await control.locator(".browser-takeover-reason").textContent()
    await expect(page.locator(".group-panel")).toHaveCount(groupPanelCount)
    await expect(page.locator(".notice-bar")).toHaveCount(0)
    const browserPage = control.getByRole("application", { name: "Página atual do navegador" })
    await expect(browserPage.locator("canvas:visible, img").first()).toBeVisible()
    const keyboard = control.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
    await expect(keyboard).toBeEnabled()
    await screenshot("control")
    const accessibility = await new AxeBuilder({ page }).include(".browser-takeover-controls").analyze()
    expect(accessibility.violations).toEqual([])
    await control.getByRole("button", { name: "Digitar no navegador" }).click()
    await expect(keyboard).toBeFocused()
    await screenshot("keyboard")
    await expect(handback).toBeInViewport({ ratio: 1 })
    await expect(control.getByRole("status", { name: "Privacidade do navegador" })).toBeInViewport({ ratio: 1 })
    await page.keyboard.insertText("entrada privada fictícia")
    await expect
      .poll(() => page.evaluate(() => (window as TakeoverWindow).getChannelTakeoverState?.().privateInputs))
      .toBe(1)
    await expect(page.getByTestId("virtual-message-list")).not.toContainText("entrada privada fictícia")

    await page.evaluate(() => (window as TakeoverWindow).completeWaitingReply?.())

    await expect(handback).toBeInViewport()
    expect(await page.evaluate(() => (window as TakeoverWindow).getChannelTakeoverState?.())).toMatchObject({
      status: "taken_over",
      notificationResolved: false,
    })
    interactionMs.push(await measureInteraction(handback))

    await expect(control).toHaveCount(0)
    await expect(composer).toBeVisible()
    expect(await page.evaluate(() => (window as TakeoverWindow).getChannelTakeoverState?.())).toMatchObject({
      status: "running",
      notificationResolved: true,
    })
    await page.evaluate(() => (window as TakeoverWindow).completeChannelResume?.())
    await expect(
      page
        .getByTestId("virtual-message-list")
        .getByText("O portal de demonstração está pronto para continuar.", { exact: true }),
    ).toBeVisible()
    await expect(page.locator(".browser-activity-card")).toHaveCount(1)
    await expect(card).toContainText("Usou o navegador · 3 ações")
    await expect(page.getByTestId("virtual-message-list")).not.toContainText("entrada privada fictícia")
    await screenshot("resumed")

    const p95Ms = getP95(interactionMs)
    const evidence = { viewport, liveWhileWaiting, previewRequests, reason, interactionMs, p95Ms, performance }
    await info.attach("takeover-state", {
      body: JSON.stringify(evidence),
      contentType: "application/json",
    })
    if (process.env.TOURI_E2E_EVIDENCE_DIR)
      await writeFile(
        join(process.env.TOURI_E2E_EVIDENCE_DIR, `metrics-${viewport.width}.json`),
        JSON.stringify(evidence),
      )

    expect(liveWhileWaiting).toBe(1)
    expect(previewRequests).toBeGreaterThan(0)
    expect(reason).toContain("O site pediu login para continuar.")
    expect(waitingStatus).toContain("Planejamento está aguardando você no navegador")
  })
}

const measureInteraction = async (button: Locator): Promise<number> => {
  await button.evaluate((element) => {
    const fixture = window as TakeoverWindow
    fixture.nextTakeoverInteraction = new Promise<number>((resolve) => {
      element.addEventListener(
        "click",
        () => {
          const startedAt = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - startedAt)))
        },
        { once: true },
      )
    })
  })

  await button.click()

  return button.page().evaluate(async () => {
    const measurement = (window as TakeoverWindow).nextTakeoverInteraction
    if (!measurement) throw new Error("Missing browser interaction measurement")

    return measurement
  })
}

const getP95 = (samples: readonly number[]): number =>
  samples.toSorted((first, second) => first - second)[Math.ceil(samples.length * 0.95) - 1] ?? 0
