import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import AxeBuilder from "@axe-core/playwright"
import { chromium, expect, test } from "@playwright/test"

test.describe.configure({ mode: "default" })
const token = randomUUID()
let child: ChildProcess
let endpoint = ""

test.beforeAll(async () => {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL
  if (!baseUrl) throw new Error("The local browser fixture URL is missing.")
  const fixtureUrl = new URL("/test/e2e/fixtures/travel-search.html", baseUrl).toString()
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

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    child.once("exit", () => done())
    child.kill("SIGTERM")
  })
})

const liveVariants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", colorScheme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light", colorScheme: "light" as const },
]

test.describe("full browser activity flow", () => {
  test.setTimeout(120_000)

  for (const variant of liveVariants) {
    test(`plays the travel search and records ${variant.name}`, async ({ browser, baseURL }, info) => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        colorScheme: variant.colorScheme,
        reducedMotion: "no-preference",
        recordVideo: { dir: info.outputDir, size: { width: variant.width, height: variant.height } },
      })
      const page = await context.newPage()
      await page.route("**/__browser-activity-fixture", async (route) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: route.request().postData() ?? "{}",
        })
        await route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        })
      })
      await page.addInitScript(() => {
        const state = { shifts: 0 }
        Object.assign(window, { __layoutShifts: state })
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>)
            if (!entry.hadRecentInput) state.shifts += entry.value
        }).observe({ type: "layout-shift", buffered: true })
      })
      await page.goto(`${baseURL}/test/e2e/browser-activity-harness.html?flow=live&theme=${variant.theme}`)
      await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()

      const card = page.getByRole("article", { name: "Navegador do Lia" })
      await expect(page.getByRole("status").filter({ hasText: "Lia está trabalhando · No navegador" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Parar o Lia" })).toBeVisible()
      if (variant.width > 600)
        await expect(page.getByRole("button", { name: /Busca de viagem/ })).toContainText("trabalhando")
      await expect(card).toBeVisible()
      await expect(card.getByRole("progressbar", { name: "Progresso do navegador" })).toBeVisible()
      await expect(card).toContainText(/Lia · abrindo uma página/)
      await expect(page.locator(".browser-activity-card")).toHaveCount(1)
      await expect(page.locator(".tool-call-card")).toHaveCount(0)
      await expect(card.getByRole("button", { name: "Assumir" })).toBeVisible()

      const livePreview = card.getByRole("img", { name: "Página atual do navegador" })
      await expect(livePreview).toBeVisible({ timeout: 60_000 })
      await expect(card.getByRole("button", { name: "Expandir navegador" })).toBeEnabled()
      const previewBox = await livePreview.boundingBox()
      await card.getByRole("button", { name: "Expandir navegador" }).click()
      if (variant.width > 600) {
        const expandedBox = await livePreview.boundingBox()
        expect(expandedBox?.width ?? 0).toBeGreaterThan((previewBox?.width ?? 0) * 1.35)
      }
      const columns = await card
        .locator(".browser-activity-content")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)
      expect(columns).toBe(1)
      await page.screenshot({ path: info.outputPath(`browser-live-${variant.name}.png`), fullPage: true })
      await card.getByRole("button", { name: "Recolher navegador" }).click()

      const results = page.getByText("Encontrei duas opções fictícias para", { exact: false })
      await expect(results).toBeVisible({ timeout: 90_000 })
      const fixtureStats = await page.evaluate(async () => {
        const response = await fetch("/__browser-activity-fixture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ step: "stats" }),
        })
        const result = (await response.json()) as { decisionCount: number; failedSteps: string[] }

        return result
      })
      expect(fixtureStats).toEqual({ decisionCount: 4, failedSteps: [] })
      await expect(page.getByText("Voo direto", { exact: false })).toBeVisible()
      await expect(page.getByText("Uma conexão", { exact: false })).toBeVisible()
      await expect(page.getByRole("progressbar", { name: "Progresso do navegador" })).toHaveCount(0)
      await expect(page.locator(".browser-activity-card")).toHaveAttribute("data-finished", "true")
      const layoutShift = await page.evaluate(
        () => (window as unknown as { __layoutShifts: { shifts: number } }).__layoutShifts.shifts,
      )
      expect(layoutShift).toBeLessThan(0.05)
      const summary = page.getByRole("button", { name: /Usou o navegador/ })
      await expect(summary).toContainText("Ver o que ele fez")
      await expect(summary.getByRole("img", { name: "Captura final do navegador" })).toBeVisible()
      await summary.click()
      const activity = page.getByRole("log", { name: "Atividade do navegador" })
      for (const action of [
        "Abriu uma página",
        "Leu a página",
        "Clicou",
        "Preencheu um campo",
        "Tirou um print",
        "Esperou a página",
        "Moveu nas abas",
      ])
        await expect(activity).toContainText(action)
      await expect(page.locator(".browser-activity-card")).toHaveCount(1)
      await expect(page.locator(".tool-call-card")).toHaveCount(0)
      const accessibility = await new AxeBuilder({ page }).include(".browser-activity-card").analyze()
      expect(accessibility.violations).toEqual([])
      await page.screenshot({ path: info.outputPath(`browser-finished-${variant.name}.png`), fullPage: true })

      const outputDirectory = process.env.TOURI_BROWSER_FLOW_OUTPUT
      if (outputDirectory) {
        await mkdir(outputDirectory, { recursive: true })
        await page.screenshot({ path: resolve(outputDirectory, `browser-${variant.name}.png`), fullPage: true })
      }
      const video = page.video()
      await context.close()
      if (video) {
        const videoPath = info.outputPath(`browser-${variant.name}.webm`)
        await video.saveAs(videoPath)
        if (outputDirectory) await video.saveAs(resolve(outputDirectory, `browser-${variant.name}.webm`))
      }
    })
  }
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
      const takeOver = page.getByRole("button", { name: isEnglish ? "Take over" : "Assumir" })
      await takeOver.focus()
      await page.keyboard.press("Enter")
      const handBack = page.getByRole("button", { name: /Hand back to|Devolver para/ })
      await expect(handBack).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`browser-${fallback}-${locale}.png`), fullPage: true })
      await handBack.click()
      await page.getByRole("button", { name: isEnglish ? "Search trips" : "Buscar viagens" }).click()
      await expect(page.getByRole("button", { name: /Used the browser|Usou o navegador/ })).toBeVisible()
    })
  }
}
