import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
import { getGuidePreviewFixture } from "../fixtures/onboarding-guide"
import { installGuideMocks } from "./onboarding-guide-mocks"
import { createGuideStaticServer } from "./onboarding-guide-static"
import { getInteractionDurations } from "./onboarding-guide-timing"

const test = base.extend<{ measurementPage: Page }, { productionUrl: string }>({
  measurementPage: async ({ browser }, use) => {
    // A separate context keeps video encoding out of the timing samples.
    const context = await browser.newContext({ colorScheme: "dark" })
    const page = await context.newPage()
    const session = await context.newCDPSession(page)
    await session.send("Performance.enable", { timeDomain: "threadTicks" })
    const profileDirectory = process.env.TOURI_ONBOARDING_PROFILE
    if (profileDirectory) {
      await session.send("Profiler.enable")
      await session.send("Profiler.start")
    }
    await use(page)
    const { metrics } = await session.send("Performance.getMetrics")
    const durations = metrics.filter(({ name }) =>
      ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].includes(name),
    )
    const navigationStart = metrics.find(({ name }) => name === "NavigationStart")?.value
    console.log(JSON.stringify({ cpu: durations, navigationStart }))
    if (profileDirectory) {
      const { profile } = await session.send("Profiler.stop")
      await writeFile(join(profileDirectory, `guide-${page.viewportSize()?.width}.cpuprofile`), JSON.stringify(profile))
    }
    await context.close()
  },
  productionUrl: [
    // biome-ignore lint/correctness/noEmptyPattern: the fixture runner discovers dependencies from this pattern.
    async ({}, use) => {
      const fixture = await createGuideStaticServer()
      await use(`${fixture.url}/test/e2e/onboarding-guide-harness.html`)
      await fixture.dispose()
    },
    { scope: "worker", timeout: 300_000 },
  ],
})

test.setTimeout(90_000)
const recording = process.env.TOURI_ONBOARDING_RECORD === "1" || Boolean(process.env.TOURI_ONBOARDING_EVIDENCE_DIR)
test.use({ video: recording ? { mode: "on", size: { width: 1440, height: 800 } } : "off", trace: "off" })
test.afterEach(async ({ context }, info) => {
  if (!info.title.startsWith("onboarding guide 1440:")) return
  const directory = process.env.TOURI_ONBOARDING_EVIDENCE_DIR
  const page = context.pages()[0]
  const video = page?.video()
  if (!directory || !page || !video) return
  await page.close()
  await video.saveAs(join(directory, "onboarding-flow.webm"))
})
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
    productionUrl,
  }, info) => {
    await runGuideFlow(page, info, width, productionUrl, false)
  })
}
test.describe("production responsiveness", () => {
  for (const width of [1440, 390]) {
    test(`onboarding production ${width}: stays within the interaction budget`, async ({
      measurementPage,
      productionUrl,
    }, info) => {
      await runGuideFlow(measurementPage, info, width, productionUrl, true)
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
  const question = page.locator("main .ob-conversation")
  await question.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
  await question.getByRole("textbox", { name: "Nome", exact: true }).press("Enter")
  await question
    .getByRole("textbox", { name: "Conte sobre seu trabalho" })
    .fill("Criamos ferramentas para pequenas equipes.")
  await question.getByRole("button", { name: "Código e deploy", exact: true }).click()
  await question.getByRole("button", { name: "Suporte", exact: true }).click()
  await question.getByRole("textbox", { name: "Site (opcional)" }).fill("https://example.com")
  await question.getByRole("button", { name: "Ler o site" }).click()
  await expect(question.getByRole("status").filter({ hasText: "primeira tarefa" })).toBeVisible()
  await captureStep(`after-context-${width}`)
  await question.getByRole("button", { name: /^Continuar/ }).click()
  await expect(question.getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true")
  await captureStep(`after-sources-${width}`)
  await question.getByRole("button", { name: /^Continuar/ }).click()
  await expect(question.getByRole("heading", { name: "Confere o que vem?" })).toBeVisible()
  await question.getByRole("checkbox", { name: /Memórias/ }).uncheck()
  await captureStep(`after-review-${width}`)
  await question.getByRole("button", { name: /Importar selecionados/ }).click()
  await expect(question.getByRole("progressbar", { name: "dev", exact: true })).toHaveAttribute("value", "1")
  await captureStep(`after-importing-${width}`)
  await question.getByRole("button", { name: /Continuar enquanto importa/ }).click()
  await expect(question.getByRole("heading", { name: "O que seus agentes podem usar?" })).toBeVisible()
  await captureStep(`after-computer-${width}`)
  const overflow = await page.locator(".ob-settings-card").evaluate((card) => card.scrollWidth - card.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  mock.finishImport()
  await question.getByRole("checkbox", { name: /Navegador/ }).check()
  await question.getByRole("button", { name: /^Continuar/ }).click()
  await expect(question.getByRole("heading", { name: "Seu time de agentes" })).toBeInViewport()
  await captureStep(`after-agents-${width}`)
  await question.getByRole("button", { name: "Conectar ou verificar conta" }).first().click()
  await expect(page.getByText("Login disponível para este bot.", { exact: true })).toBeVisible()
  await question.getByRole("button", { name: /^Continuar/ }).click()
  await expect(question.getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeVisible()
  await captureStep(`after-team-${width}`)
  await question.getByRole("button", { name: "Pular", exact: true }).click()
  await question
    .getByRole("textbox", { name: "Sua primeira tarefa" })
    .fill("Resuma o contexto e organize três prioridades.")
  await captureStep(`after-task-${width}`)
  await question.getByRole("button", { name: /Enviar primeira tarefa/ }).click()
  await expect(question.getByRole("heading", { name: "Seu touri está pronto" })).toBeVisible()
  await captureStep(`after-ready-${width}`)
  completion.resolve()
  await expect(page.getByRole("textbox", { name: /Mensagem para geral/ })).toBeVisible()
  await expect(page.getByRole("region", { name: "Coloque outro bot para trabalhar com você" })).toHaveCount(0)
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
  productionUrl,
}) => {
  await installGuideMocks(page, { team: false })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(productionUrl)
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
    longTasks: { at: number; duration: number }[]
    paints: number[]
    events: { id: number; duration: number; at: number; target: string }[]
    cls: number
    shifts: { value: number; at: number; nodes: string[] }[]
    observers: PerformanceObserver[]
  }
}
const installPerformanceProbe = (page: Page) =>
  page.evaluate(() => {
    const target = window as ProbeWindow
    // Observers append samples owned by this bounded, short-lived page flow.
    const probe = {
      longTasks: [] as { at: number; duration: number }[],
      paints: [] as number[],
      events: [] as { id: number; duration: number; at: number; target: string }[],
      cls: 0,
      shifts: [] as { value: number; at: number; nodes: string[] }[],
      observers: [] as PerformanceObserver[],
    }
    target.__guideProbe = probe
    const longTasks = new PerformanceObserver((list) =>
      probe.longTasks.push(...list.getEntries().map((entry) => ({ at: entry.startTime, duration: entry.duration }))),
    )
    longTasks.observe({ type: "longtask" })
    const events = new PerformanceObserver((list) =>
      probe.events.push(
        ...list.getEntries().flatMap((entry) => {
          const event = entry as PerformanceEntry & { interactionId: number; target: Element | null }
          return event.interactionId > 0
            ? [
                {
                  id: event.interactionId,
                  duration: event.duration,
                  at: event.startTime,
                  target: event.target?.getAttribute("aria-label") ?? event.target?.textContent?.slice(0, 60) ?? "",
                },
              ]
            : []
        }),
      ),
    )
    events.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit)
    const shifts = new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => {
        const shift = entry as PerformanceEntry & {
          hadRecentInput: boolean
          value: number
          sources: { node: Element | null }[]
        }
        if (!shift.hadRecentInput) {
          probe.cls += shift.value
          probe.shifts.push({
            value: shift.value,
            at: shift.startTime,
            nodes: shift.sources.map(({ node }) => String(node?.className ?? node?.nodeName ?? "")),
          })
        }
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
const getPerformanceMetrics = async (page: Page) => {
  const metrics = await page.evaluate(() => {
    const probe = (window as ProbeWindow).__guideProbe
    probe.observers.forEach((observer) => {
      observer.disconnect()
    })
    const paints = probe.paints.toSorted((left, right) => left - right)
    return {
      longTasks: probe.longTasks,
      interactions: paints.length,
      paintP95: paints[Math.ceil(paints.length * 0.95) - 1] ?? 0,
      cls: probe.cls,
      shifts: probe.shifts,
      eventSamples: probe.events,
    }
  })
  const events = getInteractionDurations(metrics.eventSamples)
  return { ...metrics, eventInteractions: events.length, eventP95: events[Math.ceil(events.length * 0.95) - 1] ?? 0 }
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`onboarding guide: accessible questions and contrast in ${colorScheme}`, async ({
    page,
    productionUrl,
  }, info) => {
    const mock = await installGuideMocks(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme })
    await page.goto(productionUrl)
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, colorScheme)
    const check = async () => {
      const primary = page.locator("main .ds-button-primary:enabled")
      if (await primary.count()) await primary.first().hover()
      const result = await new AxeBuilder({ page }).include("main").analyze()
      expect(result.violations).toEqual([])
    }
    await check()
    await page.getByRole("button", { name: /^Começar/ }).click()
    await check()
    await page.getByRole("button", { name: /Este (PC|Mac)/ }).click()
    await check()
    await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
    for (const color of ["Vermelho", "Dourado", "Verde", "Azul", "Roxo"]) {
      await page.getByRole("button", { name: color, exact: true }).click()
      await check()
      if (color === "Dourado") {
        await page.setViewportSize({ width: 1440, height: 800 })
        await capture(page, info, `workspace-gold-${colorScheme}-1440`)
        await page.setViewportSize({ width: 390, height: 844 })
        await page.locator(".ob-workspace-mark").scrollIntoViewIfNeeded()
        await capture(page, info, `workspace-gold-${colorScheme}-390`)
      }
    }
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
  test(`onboarding guide: connection and manual export at ${width}`, async ({ page, productionUrl }, info) => {
    await installGuideMocks(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(productionUrl)
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

const openEmptyGuide = async (page: Page, destination: string) => {
  await page.goto(destination)
  await page.getByRole("button", { name: /^Começar/ }).click()
  await page.getByRole("button", { name: /Este (PC|Mac)/ }).click()
  await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
  await page.getByRole("button", { name: /^Continuar/ }).click()
  await page.getByRole("button", { name: "Pular", exact: true }).click()
}
for (const width of [1440, 390]) {
  test(`onboarding recovery ${width}: undo while importing confirms it and returns to sources`, async ({
    page,
    productionUrl,
  }, info) => {
    const mock = await installGuideMocks(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await openEmptyGuide(page, productionUrl)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    mock.finishImport()
    await page.getByRole("button", { name: /Importar selecionados/ }).click()
    await expect(page.getByText("Pronto", { exact: true })).toHaveCount(1)
    await capture(page, info, `undo-importing-before-${width}`)

    await page.getByRole("button", { name: /Desfazer importação/ }).click()

    await expect(page.getByRole("button", { name: /Desfazer importação/ })).toHaveCount(0)
    await capture(page, info, `undo-importing-after-${width}`)
    await expect(page.getByRole("heading", { name: "Já usa agentes em outro app?" })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: "Importação desfeita. Removemos dev." })).toBeVisible()
    for (const theme of ["light", "dark"]) {
      await page.evaluate(async (value) => {
        document.documentElement.dataset.theme = value
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .map((animation) => animation.finished.catch(() => undefined)),
        )
      }, theme)
      const accessibility = await new AxeBuilder({ page }).include("main").analyze()
      expect(accessibility.violations).toEqual([])
    }
    await expect(page.getByRole("button", { name: /Claude Code/ })).toBeVisible()
    expect(mock.getBots()).toHaveLength(0)
  })
}
for (const width of [1440, 390]) {
  test(`onboarding recovery ${width}: long imported names keep the undo action inside the form`, async ({
    page,
    productionUrl,
  }, info) => {
    const names = [
      "assistente-de-planejamento-e-operacoes",
      "assistente-de-pesquisa-e-documentacao",
      "assistente-de-atendimento-e-relatorios",
    ]
    const mock = await installGuideMocks(page, { agentNames: names })
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await openEmptyGuide(page, productionUrl)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    mock.finishImport()
    await page.getByRole("button", { name: /Importar selecionados/ }).click()
    const undo = page.getByRole("button", { name: `Desfazer importação de ${names.join(", ")}`, exact: true })
    await expect(undo).toBeVisible()
    await capture(page, info, `long-import-undo-${width}`)

    const fitsForm = await undo.evaluate((button) => {
      const pane = button.closest(".ob-pane")
      if (!pane) return false
      const bounds = button.getBoundingClientRect()
      const container = pane.getBoundingClientRect()
      return bounds.left >= container.left && bounds.right <= container.right
    })

    expect(fitsForm).toBe(true)
    await undo.click()
    await expect(page.getByRole("status")).toContainText(`Importação desfeita. Removemos ${names.join(", ")}.`)
  })
}
for (const width of [1440, 390]) {
  test(`onboarding recovery ${width}: an older import keeps its names after a new preview`, async ({
    page,
    productionUrl,
  }, info) => {
    const mock = await installGuideMocks(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await openEmptyGuide(page, productionUrl)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    mock.finishImport()
    await page.getByRole("button", { name: /Importar selecionados/ }).click()
    await expect(page.getByRole("button", { name: "Desfazer importação de dev", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Voltar", exact: true }).click()
    await page.getByRole("button", { name: "Voltar", exact: true }).click()
    await page.route("**/api/v1/import/preview", (route) =>
      route.fulfill({ json: getGuidePreviewFixture("next-preview") }),
    )

    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.getByRole("heading", { name: "Confere o que vem?" })).toBeVisible()
    await page.getByRole("button", { name: "Voltar", exact: true }).click()
    await capture(page, info, `retained-import-name-${width}`)

    await page.getByRole("button", { name: "Desfazer importação de dev", exact: true }).click()
    await expect(page.getByRole("status")).toContainText("Importação desfeita. Removemos dev.")
  })
}
for (const width of [1440, 390]) {
  test(`onboarding recovery ${width}: undo and compact account rows retain avatar identity`, async ({
    page,
    productionUrl,
  }, info) => {
    const mock = await installGuideMocks(page, { agentCount: 3 })
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await openEmptyGuide(page, productionUrl)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    const reviewed = page.locator(".ob-import-agent").first().locator(".tb-avatar")
    const identity = await reviewed.getAttribute("data-avatar-shape")
    const color = await reviewed.evaluate((element) => getComputedStyle(element).getPropertyValue("--avatar-color"))
    mock.finishImport()
    await page.getByRole("button", { name: /Importar selecionados/ }).click()
    await expect(page.getByText("Pronto", { exact: true })).toHaveCount(3)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: "Voltar", exact: true }).click()
    await capture(page, info, `recovery-undo-${width}`)
    await page.getByRole("button", { name: /Desfazer importação/ }).click()
    await expect(page.getByRole("button", { name: /Desfazer importação/ })).toHaveCount(0)
    await expect(page.getByRole("status").filter({ hasText: "Importação desfeita." })).toBeVisible()
    expect(mock.getBots()).toHaveLength(0)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: /Importar selecionados/ }).click()
    await expect(page.getByText("Pronto", { exact: true })).toHaveCount(3)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.locator(".ob-agent-card")).toHaveCount(4)
    const imported = page.locator(".ob-agent-card").first().locator(".tb-avatar")
    await expect(imported).toHaveAttribute("data-avatar-shape", identity ?? "")
    expect(await imported.evaluate((element) => getComputedStyle(element).getPropertyValue("--avatar-color"))).toBe(
      color,
    )
    await capture(page, info, `recovery-four-accounts-${width}`)
    if (width === 1440) await expect(page.getByRole("button", { name: /^Continuar/ })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: /^Continuar/ }).click()
    expect(mock.calls.find((call) => call.path === "/bots/bot-dev" && call.method === "PATCH")?.body.avatarSeed).toBe(
      "dev",
    )
  })
  test(`onboarding recovery ${width}: unready account keeps the task and missing public address is explained early`, async ({
    page,
    productionUrl,
  }, info) => {
    const mock = await installGuideMocks(page)
    await page.route("**/api/v1/public-address", (route) =>
      route.fulfill({ json: { address: null, reachability: "unset" } }),
    )
    await page.route("**/api/v1/bots/*/provider-login/flow*", (route) =>
      route.fulfill({ json: { provider: "claude", state: "idle", executable: "missing" } }),
    )
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await openEmptyGuide(page, productionUrl)
    await page.getByRole("button", { name: "Pular", exact: true }).click()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await expect(page.getByRole("status")).toContainText("configure um endereço HTTPS")
    await expect(page.getByRole("button", { name: "Convidar pessoa" })).toHaveCount(0)
    await capture(page, info, `recovery-invite-${width}`)
    await page.getByRole("button", { name: "Pular", exact: true }).click()
    await page.getByRole("textbox", { name: "Sua primeira tarefa" }).fill("Organize três prioridades.")
    await page.getByRole("button", { name: /Enviar primeira tarefa/ }).click()
    await expect(page.getByRole("heading", { name: "Seu time de agentes" })).toBeVisible()
    await expect(page.getByRole("alert")).toContainText("Seu texto foi mantido")
    expect(mock.calls.some((call) => call.path === "/threads/general-thread/messages")).toBe(false)
    await capture(page, info, `recovery-account-${width}`)
    await page.route("**/api/v1/bots/*/provider-login/flow*", (route) =>
      route.fulfill({ json: { provider: "claude", state: "ready", executable: "available" } }),
    )
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: "Pular", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Sua primeira tarefa" })).toHaveValue("Organize três prioridades.")
    await capture(page, info, `recovery-task-${width}`)
    await page.getByRole("button", { name: /Enviar primeira tarefa/ }).click()
    await expect(page.getByRole("textbox", { name: /Mensagem para geral/ })).toBeVisible()
  })
}
