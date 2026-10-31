import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
import { createGuideBuild } from "./onboarding-guide-build"
import { installGuideMocks } from "./onboarding-guide-mocks"

const test = base.extend<object, { productionUrl: string }>({
  productionUrl: [
    async ({ browserName }, use) => {
      const fixture = await createGuideBuild("guide", [], browserName)
      await use(fixture.url)
      await fixture.stop()
    },
    { scope: "worker", timeout: 300_000 },
  ],
})

test.setTimeout(90_000)
test.use({ video: { mode: "on", size: { width: 1440, height: 800 } } })
test.afterEach(async ({ page }, info) => {
  if (!info.title.startsWith("onboarding guide 1440:")) return
  const directory = process.env.TOURI_ONBOARDING_EVIDENCE_DIR
  const video = page.video()
  if (!directory || !video) return
  await page.close()
  await video.saveAs(join(directory, "onboarding-flow.webm"))
})
const url = "/test/e2e/onboarding-guide-harness.html"
const capture = async (page: Page, info: TestInfo, name: string) => {
  const directory = process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir
  await mkdir(directory, { recursive: true })
  await info.attach(name, {
    body: await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled", fullPage: false }),
    contentType: "image/png",
  })
}
for (const width of [1440, 390]) {
  test(`onboarding guide ${width}: review imports, keep progress live, configure and land in general`, async ({
    page,
  }, info) => {
    await runGuideFlow(page, info, width, url, false)
  })
}
test.describe("production responsiveness", () => {
  test.use({ video: "off", trace: "off" })
  for (const width of [1440, 390]) {
    test(`onboarding production ${width}: stays within the interaction budget`, async ({
      page,
      productionUrl,
    }, info) => {
      await runGuideFlow(page, info, width, productionUrl, true)
    })
  }
})

const runGuideFlow = async (page: Page, info: TestInfo, width: number, destination: string, measure: boolean) => {
  const captureStep = async (name: string) => {
    if (!measure) await capture(page, info, name)
  }
  const mock = await installGuideMocks(page)
  const completion = Promise.withResolvers<void>()
  await page.route("**/api/v1/onboarding", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    await completion.promise
    await route.fulfill({ json: { completed: true, url: null } })
  })
  await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
  await page.goto(destination)
  await expect(page.getByRole("heading", { name: "Seu time e seus agentes, no mesmo chat" })).toBeVisible()
  await captureStep(`after-welcome-${width}`)
  await page.getByRole("button", { name: /^Começar/ }).click()
  await captureStep(`after-location-${width}`)
  await page.getByRole("button", { name: /Este (PC|Mac)/ }).click()
  await expect(page.getByRole("heading", { name: "Como chama seu espaço?" })).toBeVisible()
  await captureStep(`after-workspace-${width}`)
  if (measure) {
    await page.evaluate(() => document.fonts.ready)
    await installPerformanceProbe(page)
  }
  await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
  await page.getByRole("textbox", { name: "Nome", exact: true }).press("Enter")
  await page
    .getByRole("textbox", { name: "Conte sobre seu trabalho" })
    .fill("Criamos ferramentas para pequenas equipes.")
  await page.getByRole("button", { name: "Código e deploy", exact: true }).click()
  await page.getByRole("button", { name: "Suporte", exact: true }).click()
  await page.getByRole("textbox", { name: "Site (opcional)" }).fill("https://example.com")
  await page.getByRole("button", { name: "Ler o site" }).click()
  await expect(page.getByRole("status").filter({ hasText: "primeira tarefa" })).toBeVisible()
  await captureStep(`after-context-${width}`)
  await page.getByRole("button", { name: /^Continuar/ }).click()
  await expect(page.getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true")
  await captureStep(`after-sources-${width}`)
  await page.getByRole("button", { name: /^Continuar/ }).click()
  await expect(page.getByRole("heading", { name: "Confere o que vem?" })).toBeVisible()
  await page.getByRole("checkbox", { name: /Memórias/ }).uncheck()
  await captureStep(`after-review-${width}`)
  await page.getByRole("button", { name: /Importar selecionados/ }).click()
  await expect(page.getByRole("progressbar", { name: "dev", exact: true })).toHaveAttribute("value", "1")
  await captureStep(`after-importing-${width}`)
  await page.getByRole("button", { name: /Continuar enquanto importa/ }).click()
  await expect(page.getByRole("heading", { name: "O que seus agentes podem usar?" })).toBeVisible()
  await captureStep(`after-computer-${width}`)
  mock.finishImport()
  await page.getByRole("checkbox", { name: /Navegador/ }).check()
  await page.getByRole("button", { name: /^Continuar/ }).click()
  await expect(page.getByRole("heading", { name: "Seu time de agentes" })).toBeInViewport()
  await captureStep(`after-agents-${width}`)
  await page.getByRole("button", { name: "Conectar ou verificar conta" }).first().click()
  await expect(page.getByText("Login disponível para este bot.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /^Continuar/ }).click()
  await expect(page.getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeVisible()
  await captureStep(`after-team-${width}`)
  await page.getByRole("button", { name: "Pular", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Sua primeira tarefa" })
    .fill("Resuma o contexto e organize três prioridades.")
  await captureStep(`after-task-${width}`)
  await page.getByRole("button", { name: /Enviar primeira tarefa/ }).click()
  await expect(page.getByRole("heading", { name: "Seu touri está pronto" })).toBeVisible()
  await captureStep(`after-ready-${width}`)
  completion.resolve()
  await expect(page.getByRole("textbox", { name: /Mensagem para geral/ })).toBeVisible()
  await captureStep(`after-general-${width}`)
  if (measure) {
    const metrics = await getPerformanceMetrics(page)
    console.log(JSON.stringify({ width, ...metrics }))
    await info.attach(`fluidity-${width}`, { body: JSON.stringify(metrics, null, 2), contentType: "application/json" })
    expect(metrics.longTasks).toHaveLength(0)
    expect(metrics.paintP95).toBeLessThan(100)
    expect(metrics.eventP95).toBeLessThan(100)
    expect(metrics.cls).toBeLessThan(0.01)
  }
  const apply = mock.calls.find((call) => call.path === "/import/apply")
  expect(apply?.body).toEqual({
    previewId: "preview-one",
    select: { dev: { instructions: true, skills: true, memories: false, routines: true } },
  })
  expect(mock.calls.some((call) => call.path.includes("/routines/") && call.method !== "GET")).toBe(false)
  expect(mock.calls.find((call) => call.path === "/threads/general-thread/messages")?.body.text).toContain(
    "https://example.com",
  )
  expect(mock.getBots()).toHaveLength(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test("onboarding guide: manual export and keyboard back remain usable with reduced motion and missing team routes", async ({
  page,
}) => {
  await installGuideMocks(page, { team: false })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(url)
  await page.getByRole("button", { name: /^Começar/ }).click()
  await page.getByRole("button", { name: /Este (PC|Mac)/ }).click()
  await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
  await page.getByRole("textbox", { name: "Nome", exact: true }).press("Enter")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("textbox", { name: "Nome", exact: true })).toHaveValue("Equipe exemplo")
  await page.getByRole("textbox", { name: "Nome", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Pular" }).click()
  await page.getByRole("button", { name: /Outro app \(pedido de exportação\)/ }).click()
  await page.getByRole("textbox", { name: "Resposta em JSON" }).fill('{"agents":[{"name":"dev"}]}')
  await page.getByRole("button", { name: /^Continuar/ }).click()
  await expect(page.getByRole("heading", { name: "Confere o que vem?" })).toBeVisible()
})
type ProbeWindow = Window & {
  __guideProbe: {
    longTasks: number[]
    paints: number[]
    events: { id: number; duration: number }[]
    cls: number
    observers: PerformanceObserver[]
  }
}
const installPerformanceProbe = (page: Page) =>
  page.evaluate(() => {
    const target = window as ProbeWindow
    // Observers append measurements owned by this bounded, short-lived page flow.
    const probe = {
      longTasks: [] as number[],
      paints: [] as number[],
      events: [] as { id: number; duration: number }[],
      cls: 0,
      observers: [] as PerformanceObserver[],
    }
    target.__guideProbe = probe
    const longTasks = new PerformanceObserver((list) =>
      probe.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    )
    longTasks.observe({ type: "longtask" })
    const events = new PerformanceObserver((list) =>
      probe.events.push(
        ...list.getEntries().flatMap((entry) => {
          const event = entry as PerformanceEntry & { interactionId: number }
          return event.interactionId > 0 ? [{ id: event.interactionId, duration: event.duration }] : []
        }),
      ),
    )
    events.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit)
    const shifts = new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }
        if (!shift.hadRecentInput) probe.cls += shift.value
      }),
    )
    shifts.observe({ type: "layout-shift" })
    probe.observers.push(longTasks, events, shifts)
    document.addEventListener(
      "click",
      () => {
        const start = performance.now()
        requestAnimationFrame(() => requestAnimationFrame(() => probe.paints.push(performance.now() - start)))
      },
      { capture: true },
    )
  })
const getPerformanceMetrics = (page: Page) =>
  page.evaluate(() => {
    const probe = (window as ProbeWindow).__guideProbe
    probe.observers.forEach((observer) => {
      observer.disconnect()
    })
    const paints = probe.paints.toSorted((left, right) => left - right)
    const events = Array.from(new Map(probe.events.map((event) => [event.id, event.duration])).values()).toSorted(
      (left, right) => left - right,
    )
    return {
      longTasks: probe.longTasks,
      interactions: paints.length,
      paintP95: paints[Math.ceil(paints.length * 0.95) - 1] ?? 0,
      eventInteractions: events.length,
      eventP95: events[Math.ceil(events.length * 0.95) - 1] ?? 0,
      cls: probe.cls,
    }
  })

for (const colorScheme of ["light", "dark"] as const) {
  test(`onboarding guide: accessible questions and contrast in ${colorScheme}`, async ({ page }) => {
    const mock = await installGuideMocks(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme })
    await page.goto(url)
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, colorScheme)
    const check = async () => {
      const result = await new AxeBuilder({ page }).include("main").analyze()
      expect(result.violations).toEqual([])
    }
    await check()
    await page.getByRole("button", { name: /^Começar/ }).click()
    await check()
    await page.getByRole("button", { name: /Este (PC|Mac)/ }).click()
    await check()
    await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await check()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.getByRole("button", { name: /Claude Code/ })).toBeVisible()
    await check()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.getByRole("heading", { name: "Confere o que vem?" })).toBeVisible()
    await check()
    await page.getByRole("button", { name: /Importar selecionados/ }).click()
    await expect(page.getByRole("progressbar", { name: "dev", exact: true })).toBeVisible()
    await check()
    mock.finishImport()
    await expect(page.getByText("Pronto", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await check()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.getByRole("heading", { name: "Seu time de agentes" })).toBeVisible()
    await check()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeVisible()
    await check()
    await page.getByRole("button", { name: "Pular", exact: true }).click()
    await check()
  })
}

for (const width of [1440, 390]) {
  test(`onboarding guide: connection and manual export at ${width}`, async ({ page }, info) => {
    await installGuideMocks(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(url)
    await page.getByRole("button", { name: /^Começar/ }).click()
    await page.getByRole("button", { name: /Conectar ao meu servidor/ }).click()
    await capture(page, info, `after-connect-${width}`)
    await page.getByRole("textbox", { name: "Endereço do servidor" }).fill("https://server.example.com")
    await page.getByRole("button", { name: "Conectar ao servidor", exact: true }).click()
    await capture(page, info, `after-pair-${width}`)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /Este (PC|Mac)/ }).click()
    await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: "Pular", exact: true }).click()
    await page.getByRole("button", { name: /Outro app/ }).click()
    await capture(page, info, `after-manual-${width}`)
  })
}
