import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import AxeBuilder from "@axe-core/playwright"
import {
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test"
import { test } from "./production-fixture"

test.describe.configure({ mode: "default" })
const token = randomUUID()
const contexts = new Set<BrowserContext>()
let child: ChildProcess
let endpoint = ""

test.beforeAll(async ({ productionBaseURL }) => {
  const fixtureUrl = new URL("/test/e2e/fixtures/travel-search.html", productionBaseURL).toString()
  child = spawn("bun", [resolve("test/e2e/browser-activity-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TOURI_CHROME_BIN: chromium.executablePath(),
      TOURI_BROWSER_HEADLESS: "1",
      TOURI_BROWSER_FLOW_TOKEN: token,
      TOURI_BROWSER_FLOW_FIXTURE_URL: fixtureUrl,
    },
  })
  await new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("The local browser fixture did not start.")), 20_000)
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    lines.on("line", (line) => {
      if (!line.startsWith("BROWSER_ACTIVITY_FIXTURE:")) return
      endpoint = `http://127.0.0.1:${Number(line.split(":")[1])}`
      clearTimeout(timeout)
      accept()
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error("The local browser fixture exited."))
    })
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
  })
})

test.afterEach(async () => {
  const opened = Array.from(contexts)
  contexts.clear()
  await Promise.all(opened.map((context) => context.close()))
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    child.once("exit", () => done())
    child.kill("SIGTERM")
  })
})

const getEvidencePath = (info: TestInfo, name: string): string =>
  process.env.TOURI_E2E_EVIDENCE_DIR ? resolve(process.env.TOURI_E2E_EVIDENCE_DIR, name) : info.outputPath(name)

const connectBrowserFixture = async (page: Page): Promise<void> => {
  await page.route("**/__browser-activity-fixture", async (route) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: route.request().postData() ?? "{}",
    })
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() })
  })
}

const liveVariants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", colorScheme: "dark" as const },
  { name: "desktop-light", width: 1440, height: 900, theme: "light", colorScheme: "light" as const },
  { name: "compact-desktop", width: 1024, height: 700, theme: "dark", colorScheme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light", colorScheme: "light" as const },
  { name: "phone-dark", width: 390, height: 844, theme: "dark", colorScheme: "dark" as const },
]

test.describe("full browser activity flow", () => {
  test.setTimeout(120_000)

  for (const variant of liveVariants) {
    test(`plays the travel search and records ${variant.name}`, async ({ browser, baseURL }, info) => {
      const outputDirectory = process.env.TOURI_BROWSER_FLOW_OUTPUT
      const recordingOptions: BrowserContextOptions = outputDirectory
        ? { recordVideo: { dir: info.outputDir, size: { width: variant.width, height: variant.height } } }
        : {}
      const context = await browser.newContext(
        Object.assign(
          {
            viewport: { width: variant.width, height: variant.height },
            colorScheme: variant.colorScheme,
            hasTouch: variant.width <= 600,
            isMobile: variant.width <= 600,
            reducedMotion: "no-preference",
          },
          recordingOptions,
        ),
      )
      contexts.add(context)
      const page = await context.newPage()
      await connectBrowserFixture(page)
      await page.goto(
        `${baseURL}/test/e2e/browser-activity-harness.html?flow=live&theme=${variant.theme}&holdAfterOpen=true`,
      )
      await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()

      const card = page.getByRole("article", { name: "Navegador do Lia" })
      await expect(page.getByRole("status").filter({ hasText: "Lia está trabalhando · No navegador" })).toBeVisible()
      const stopBrowserTask = page.getByRole("button", { name: "Parar Lia" })
      await expect(stopBrowserTask).toBeVisible()
      if (variant.width <= 600) {
        const touchTarget = await stopBrowserTask.boundingBox()
        expect(touchTarget?.width ?? 0).toBeGreaterThanOrEqual(44)
        expect(touchTarget?.height ?? 0).toBeGreaterThanOrEqual(44)
      }
      if (variant.width > 600)
        await expect(page.getByRole("button", { name: /Busca de viagem/ })).toContainText("trabalhando")
      await expect(card).toBeVisible({ timeout: 40_000 })
      await expect(card.locator(".browser-activity-chrome")).toContainText("travel.example.test")
      await expect(card.getByText(/travel\.example\.test/)).toHaveCount(1)
      await expect(card.getByRole("progressbar", { name: "Progresso do navegador" })).toBeVisible()
      await expect(card.locator(".browser-activity-subtitle")).toContainText("O bot está usando o navegador.")
      await expect(page.locator(".browser-activity-card")).toHaveCount(1)
      await expect(page.locator(".tool-call-card")).toHaveCount(0)
      await expect(card.getByRole("button", { name: "Assumir" })).toBeVisible({ timeout: 20_000 })

      await expect(card.getByRole("button", { name: "Assumir" })).toBeEnabled({ timeout: 40_000 })
      const livePreview = card.getByRole("img", { name: "Página atual do navegador" })
      await expect(livePreview).toBeVisible({ timeout: 40_000 })
      await expect(card.getByRole("button", { name: "Ampliar tela do navegador" })).toBeEnabled()
      const initialColumns = await card
        .locator(".browser-activity-content")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)
      expect(initialColumns).toBe(1)
      const expandBrowser = card.locator(".browser-activity-header-actions .browser-activity-icon-button").first()
      await expandBrowser.click()
      await expect(expandBrowser).toHaveAccessibleName("Reduzir tela do navegador")
      await expect(expandBrowser).not.toHaveAttribute("aria-pressed")
      await expect(expandBrowser).not.toHaveAttribute("aria-expanded")
      await expect(card.locator(".browser-activity-preview")).toHaveClass(/browser-activity-preview-full/)
      const columns = await card
        .locator(".browser-activity-content")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)
      expect(columns).toBe(1)
      await expect(card.locator(".browser-activity-log")).toHaveCSS("overflow", "visible")
      await page.screenshot({ path: getEvidencePath(info, `browser-live-${variant.name}.png`), fullPage: true })
      await card.getByRole("button", { name: "Reduzir tela do navegador" }).click()
      const takeOver = page.locator(".composer-browser-status").getByRole("button", { name: "Assumir" })
      await expect(takeOver).toBeVisible()
      await takeOver.click()
      await expect(page.getByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
      const takeoverView = page.getByRole("region", { name: "Controle remoto do navegador" })
      const remoteScreen = takeoverView.locator(".browser-takeover-screen")
      const privacy = takeoverView.getByRole("status", { name: "Privacidade do navegador" })
      await expect(remoteScreen).toBeVisible()
      await expect(privacy).toBeVisible()
      await expect(takeoverView.locator(".browser-takeover-controls")).toHaveCSS("position", "sticky")
      await remoteScreen.scrollIntoViewIfNeeded()
      await remoteScreen.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      await expect(page.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
      await remoteScreen.click()
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const response = await fetch("/__browser-activity-fixture", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ step: "stats" }),
            })
            return ((await response.json()) as { takeoverInputCount: number }).takeoverInputCount
          }),
        )
        .toBe(2)
      await page
        .getByRole("region", { name: "Controle remoto do navegador" })
        .getByRole("button", { name: /Devolver para/ })
        .click()
      await page.evaluate(() => {
        const browserWindow = window as Window & { browserActivity?: { continueAfterOpen: () => void } }
        browserWindow.browserActivity?.continueAfterOpen()
      })

      const results = page.getByText("Encontrei duas opções fictícias para", { exact: false })
      await expect(results).toBeVisible({ timeout: 90_000 })
      const fixtureStats = await page.evaluate(async () => {
        const response = await fetch("/__browser-activity-fixture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step: "stats" }),
        })
        const result = (await response.json()) as {
          decisionCount: number
          failedSteps: string[]
          takeoverInputCount: number
        }

        return result
      })
      expect(fixtureStats).toEqual({
        decisionCount: 4,
        failedSteps: [],
        takeoverInputCount: 2,
        takeoverInputAttempts: 2,
      })
      await expect(page.getByText("Voo direto", { exact: false })).toBeVisible()
      await expect(page.getByText("Uma conexão", { exact: false })).toBeVisible()
      await expect(page.getByRole("progressbar", { name: "Progresso do navegador" })).toHaveCount(0)
      await expect(page.locator(".browser-activity-card")).toHaveAttribute("data-finished", "true")
      const summary = page.getByRole("button", { name: /Usou o navegador/ })
      await expect(summary).toContainText("Ver as etapas")
      await summary.scrollIntoViewIfNeeded()
      await page.screenshot({ path: getEvidencePath(info, `browser-summary-${variant.name}.png`), fullPage: true })
      await expect(summary.getByRole("img", { name: "Print final do navegador" })).toBeVisible()
      await expect
        .poll(() =>
          summary.getByRole("img", { name: "Print final do navegador" }).evaluate((image) => {
            return image instanceof HTMLImageElement ? image.naturalWidth : 0
          }),
        )
        .toBeGreaterThan(0)
      await summary.click()
      const activity = page.getByRole("log", { name: "Atividade do navegador" })
      for (const action of [
        "Abriu uma página",
        "Leu a página",
        "Clicou",
        "Preencheu um campo",
        "Tirou um print",
        "Aguardou a página",
        "Trocou de aba",
      ])
        await expect(activity).toContainText(action)
      await expect(page.locator(".browser-activity-card")).toHaveCount(1)
      await expect(page.locator(".tool-call-card")).toHaveCount(0)
      const accessibility = await new AxeBuilder({ page }).include(".browser-activity-card").analyze()
      expect(accessibility.violations).toEqual([])
      await page.screenshot({ path: getEvidencePath(info, `browser-finished-${variant.name}.png`), fullPage: true })

      if (outputDirectory) {
        await mkdir(outputDirectory, { recursive: true })
        await page.screenshot({ path: resolve(outputDirectory, `browser-${variant.name}.png`), fullPage: true })
      }
      const video = page.video()
      await context.close()
      if (video) {
        const videoPath = getEvidencePath(info, `browser-${variant.name}.webm`)
        await video.saveAs(videoPath)
        if (outputDirectory) await video.saveAs(resolve(outputDirectory, `browser-${variant.name}.webm`))
      }
    })
  }
})

for (const viewport of [
  { name: "compact-desktop", width: 1024, height: 700 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`server browser takeover stays interactive and private: ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto("/test/e2e/browser-activity-harness.html?remote=true&holdAfterOpen=true")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    await expect(
      page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }),
    ).toBeVisible()
    await page.screenshot({
      path: getEvidencePath(testInfo, `browser-takeover-before-${viewport.name}.png`),
      fullPage: true,
    })

    await page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }).click()
    await expect(page.getByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
    await expect(page.getByText(/você está usando/)).toBeVisible()
    const takeoverView = page.getByRole("region", { name: "Controle remoto do navegador" })
    const browserScreen = takeoverView.locator(".browser-takeover-screen")
    const privacy = takeoverView.getByRole("status", { name: "Privacidade do navegador" })
    await expect(browserScreen).toBeVisible()
    await expect(privacy).toBeVisible()
    await expect(takeoverView.locator(".browser-takeover-controls")).toHaveCSS("position", "sticky")
    const screenWidth = await browserScreen.evaluate((element) => element.getBoundingClientRect().width)
    const layoutWidth = await takeoverView
      .locator(".browser-takeover-layout")
      .evaluate((element) => element.getBoundingClientRect().width)
    expect(screenWidth).toBeGreaterThan(layoutWidth * 0.95)
    await page.screenshot({
      path: getEvidencePath(testInfo, `browser-takeover-after-${viewport.name}.png`),
      fullPage: true,
    })

    if (viewport.width > 600)
      await takeoverView.getByRole("button", { name: "Expandir navegador em tela cheia" }).click()
    await expect(takeoverView).toHaveAttribute("data-full-view", "true")
    const fullScreenHeight = await browserScreen.evaluate((element) => element.getBoundingClientRect().height)
    expect(fullScreenHeight).toBeGreaterThan(viewport.height * 0.6)

    await expect(page.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
    const keyboard = page.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
    await keyboard.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      textarea.value = "valor privado de teste"
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const browserActivityWindow = window as Window & {
            browserActivity?: { snapshot: () => { takeoverInputCount: number } }
          }
          return browserActivityWindow.browserActivity?.snapshot().takeoverInputCount
        }),
      )
      .toBe(1)
    await expect(keyboard).toHaveValue("")
    await expect(page.locator("body")).not.toContainText("valor privado de teste")

    await takeoverView.getByRole("button", { name: "Devolver para Mark" }).click()
    await expect(
      page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }),
    ).toBeVisible()
  })
}
test("Composer stop cancels the active browser run and prevents later browser actions", async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const browserActions: string[] = []
  const browserActionSteps = new Set([
    "open",
    "read",
    "destination",
    "option",
    "cabin",
    "calendar",
    "date",
    "search",
    "wait",
    "tabs",
    "screenshot",
  ])
  await page.route("**/__browser-activity-fixture", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { step?: string; runId?: string }
    if (body.step && browserActionSteps.has(body.step)) browserActions.push(body.step)
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() })
  })
  await page.goto(`${baseURL}/test/e2e/browser-activity-harness.html?flow=live&holdAfterOpen=true`)

  await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
  await expect(page.getByRole("article", { name: "Navegador do Lia" })).toBeVisible()
  await expect.poll(() => browserActions).toEqual(["open"])
  await page.waitForFunction(() => {
    const browserActivity = (
      window as Window & {
        browserActivity?: { snapshot: () => { running: boolean; parts: Array<{ ok?: boolean }> } }
      }
    ).browserActivity
    const snapshot = browserActivity?.snapshot()

    return snapshot?.running === true && snapshot.parts.at(-1)?.ok === true
  })

  await page.getByRole("button", { name: "Parar Lia" }).click()
  await page.waitForFunction(() => {
    const browserActivity = (
      window as Window & {
        browserActivity?: { snapshot: () => { cancelledRunIds: string[] } }
      }
    ).browserActivity

    return browserActivity?.snapshot().cancelledRunIds.includes("browser-flow-run") === true
  })
  await page.evaluate(() => {
    const browserActivity = (window as Window & { browserActivity?: { continueAfterOpen: () => void } }).browserActivity
    browserActivity?.continueAfterOpen()
  })
  await page.waitForFunction(() => {
    const browserActivity = (window as Window & { browserActivity?: { snapshot: () => { settled: boolean } } })
      .browserActivity

    return browserActivity?.snapshot().settled === true
  })

  expect(browserActions).toEqual(["open"])
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
      const takeOver = page
        .locator(".browser-activity-card")
        .getByRole("button", { name: isEnglish ? "Take over" : "Assumir", exact: true })
      await takeOver.focus()
      await page.keyboard.press("Enter")
      const handBack = page
        .locator(".browser-activity-card")
        .getByRole("button", { name: /Hand back to|Devolver para/ })
      await expect(handBack).toBeVisible()
      await page.screenshot({ path: getEvidencePath(testInfo, `browser-${fallback}-${locale}.png`), fullPage: true })
      await handBack.click()
      await page.getByRole("button", { name: isEnglish ? "Search trips" : "Buscar viagens" }).click()
      await expect(page.getByRole("button", { name: /Used the browser|Usou o navegador/ })).toBeVisible()
    })
  }
}

for (const width of [360, 390, 430, 1440]) {
  test(`finished browser card without an image stays compact at ${width}px`, async ({ page }) => {
    const evidence = resolve(import.meta.dirname, "../../../docs/qa/landing-bugs")
    await mkdir(evidence, { recursive: true })
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/test/e2e/browser-activity-harness.html?screenshot=none")
    await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
    await page.getByRole("button", { name: "Buscar viagens" }).click()
    const summary = page.getByRole("button", { name: /Usou o navegador/ })
    await expect(summary).toBeVisible()
    await expect(summary.locator("img")).toHaveCount(0)
    await page.screenshot({ path: `${evidence}/browser-no-image-${width}.png` })

    expect((await summary.boundingBox())?.height).toBeLessThan(90)
    await expect(summary).toContainText("Ver as etapas")
    await summary.click()
    await expect(page.getByText("Atividade do navegador", { exact: true })).toBeVisible()
  })
}

test("browser activity and travel fixtures load compiled modules", async ({ page }) => {
  const activity = await page.goto("/test/e2e/browser-activity-harness.html?remote=true")

  expect(activity?.status()).toBe(200)
  await expect(page.getByRole("button", { name: "Iniciar busca de viagem" })).toBeVisible()
  await expect(page.locator('script[type="module"][src^="/assets/"]')).toHaveCount(1)
  await expect(page.locator('script[src*="/@vite/"], script[src*=".tsx"]')).toHaveCount(0)

  const travel = await page.goto("/test/e2e/fixtures/travel-search.html")

  expect(travel?.status()).toBe(200)
  await expect(page.getByRole("textbox", { name: "Destination primary" })).toBeVisible()
  await expect(page.locator('script[type="module"][src^="/assets/"]')).toHaveCount(1)
  await expect(page.locator('script[src*="/@vite/"], script[src*=".tsx"]')).toHaveCount(0)
})
