import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { chromium, expect, type Page, test } from "@playwright/test"

const token = randomUUID()
let child: ChildProcess
let endpoint = ""
const baseline = process.env.TOURI_BROWSER_PHASE === "before"
test.use({ video: "on", hasTouch: true })

test.beforeAll(async ({ baseURL }) => {
  child = spawn("bun", [resolve("test/e2e/browser-activity-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      TOURI_BROWSER_FLOW_TOKEN: token,
      TOURI_BROWSER_FLOW_FIXTURE_URL: `${baseURL}/test/e2e/fixtures/travel-search.html`,
      TOURI_BROWSER_HEADLESS: "1",
      TOURI_CHROME_BIN: chromium.executablePath(),
    }),
  })
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser fixture did not start")), 30_000)
    if (!child.stdout) throw new Error("Missing fixture output")
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      if (!line.startsWith("BROWSER_ACTIVITY_FIXTURE:")) return
      endpoint = `http://127.0.0.1:${Number(line.split(":")[1])}`
      clearTimeout(timer)
      accept()
    })
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Browser fixture exited"))
    })
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    child.once("exit", () => done())
    child.kill("SIGTERM")
  })
})

const post = async (step: string) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ step }),
    signal: AbortSignal.timeout(30_000),
  })
  expect(response.ok).toBe(true)
  return response.json()
}

const openBrowser = async (page: Page) => {
  await page.route("**/__browser-activity-fixture", async (route) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: route.request().postData() ?? "{}",
      signal: AbortSignal.timeout(40_000),
    })
    await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() })
  })
  await page.goto("/test/e2e/browser-activity-harness.html?flow=live&holdAfterOpen=true")
  await page.getByRole("button", { name: "Iniciar busca de viagem" }).click()
  const card = page.getByRole("article", { name: "Navegador do Lia" })
  await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible({ timeout: 40_000 })
  await card.getByRole("button", { name: "Assumir", exact: true }).click()
  const view = page.getByRole("region", { name: "Controle remoto do navegador" })
  await expect(view.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled({ timeout: 20_000 })
  return { card, view }
}

for (const width of [1440, 390]) {
  test(`human browser fullscreen, input and safe preview recovery at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    if (width === 390)
      await page.addInitScript(() => {
        Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", { value: undefined })
      })
    const { card, view } = await openBrowser(page)
    const evidence = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(evidence, { recursive: true })
    await page.evaluate(() => {
      const samples: number[] = []
      let cls = 0
      const observer = new PerformanceObserver((list) => {
        samples.push(
          ...list
            .getEntries()
            .filter((entry) => entry.entryType === "longtask")
            .map((entry) => entry.duration),
        )
        cls += list
          .getEntries()
          .filter((entry) => entry.entryType === "layout-shift")
          .reduce((sum, entry) => {
            const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
            return sum + (shift.hadRecentInput ? 0 : shift.value)
          }, 0)
      })
      observer.observe({ entryTypes: ["longtask", "layout-shift"] })
      Object.assign(window, { humanBrowserMetrics: { samples, observer, getCls: () => cls } })
    })
    await view.getByRole("button", { name: "Expandir navegador em tela cheia" }).evaluate((button) => {
      button.addEventListener(
        "click",
        () => {
          const start = performance.now()
          requestAnimationFrame(() => Object.assign(window, { humanBrowserInteractionMs: performance.now() - start }))
        },
        { once: true },
      )
    })
    await view.getByRole("button", { name: "Expandir navegador em tela cheia" }).click()
    if (!baseline) {
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
      const screen = view.getByRole("application", { name: "Página atual do navegador" })
      const result = await page.waitForResponse(async (response) => {
        if (!response.url().endsWith("/__browser-activity-fixture") || !response.ok()) return false
        const body = response.request().postDataJSON()
        return (
          body.step === "takeover-frame" &&
          body.viewport?.width === Math.round((await screen.boundingBox())?.width ?? 0)
        )
      })
      const frame = await result.json()
      const bounds = await screen.boundingBox()
      expect(frame.width).toBe(Math.round(bounds?.width ?? 0))
      expect(frame.height).toBe(Math.round(bounds?.height ?? 0))
      expect((await view.boundingBox())?.width).toBe(width)
      if (width === 390) await expect(view.locator(".browser-takeover-image")).toBeInViewport()
      await expect(view.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
      const target = await post("private-target")
      if (!bounds) throw new Error("Missing remote screen")
      const x = bounds.x + (target.x / target.width) * bounds.width
      const y = bounds.y + (target.y / target.height) * bounds.height
      if (width === 390) await page.touchscreen.tap(x, y)
      else await page.mouse.click(x, y)
      await view.getByRole("button", { name: "Digitar no navegador" }).click()
      await page.keyboard.insertText("entrada privada fictícia")
      await expect.poll(async () => (await post("private-input-status")).received).toBe(true)
    }
    await page.screenshot({ path: resolve(evidence, `${baseline ? "before" : "after"}-fullscreen-${width}.png`) })
    const interactions = await Array.from({ length: 20 }, (_, index) => index).reduce(async (previous, attempt) => {
      const timings = await previous
      const expanded = attempt % 2 === 1
      const button = view.getByRole("button", {
        name: expanded ? "Expandir navegador em tela cheia" : "Recolher navegador em tela cheia",
      })
      await button.evaluate((element) =>
        element.addEventListener(
          "click",
          () => {
            const start = performance.now()
            requestAnimationFrame(() => Object.assign(window, { humanBrowserInteractionMs: performance.now() - start }))
          },
          { once: true },
        ),
      )
      await button.click()
      await expect(view).toHaveAttribute("data-full-view", String(expanded))
      if (!baseline) await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(expanded)
      const timing = await page.evaluate(
        () => (window as Window & { humanBrowserInteractionMs?: number }).humanBrowserInteractionMs ?? 1000,
      )
      return timings.concat(timing)
    }, Promise.resolve<number[]>([]))
    const sorted = interactions.toSorted((left, right) => left - right)
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 1000
    if (!baseline) expect(p95Ms).toBeLessThan(100)
    await page.keyboard.press("Escape")
    if (!baseline) await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false)
    await view.getByRole("button", { name: /Devolver para/ }).click()
    await expect(view).toHaveCount(0)
    await expect(card.getByRole("img", { name: "Página atual do navegador" })).toHaveCount(0)
    await post("public-navigation")
    if (!baseline)
      await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: resolve(evidence, `${baseline ? "before" : "after"}-preview-${width}.png`) })
    const metrics = await page.evaluate(() => {
      const recorded = (
        window as Window & {
          humanBrowserMetrics?: { samples: number[]; observer: PerformanceObserver; getCls: () => number }
        }
      ).humanBrowserMetrics
      recorded?.observer.disconnect()
      return {
        longTasks: recorded?.samples ?? [],
        cls: recorded?.getCls() ?? 1,
        interactionMs: (window as Window & { humanBrowserInteractionMs?: number }).humanBrowserInteractionMs,
      }
    })
    console.log(
      JSON.stringify({
        width,
        phase: baseline ? "before" : "after",
        p95Ms,
        samples: interactions.length,
        metrics,
      }),
    )
    if (!baseline) expect(metrics.longTasks).toEqual([])
    if (!baseline) expect(metrics.cls).toBeLessThan(0.01)
  })
}

for (const width of [1440, 390]) {
  test(`Work channel takeover fills the window and returns with Back at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/channel-takeover-harness.html")
    const composer = page.getByRole("textbox", { name: "Mensagem para Equipe de viagens" })
    await composer.fill("@Planejamento confira o portal de demonstração e continue depois do login.")
    await composer.press("Enter")
    const card = page.locator(".browser-activity-card").first()
    await card.getByRole("button", { name: "Assumir", exact: true }).click()
    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    if (width === 390)
      await view.evaluate((element) => Object.defineProperty(element, "requestFullscreen", { value: undefined }))
    await view.getByRole("button", { name: "Expandir navegador em tela cheia" }).click()
    if (!baseline) {
      await expect.poll(async () => (await view.boundingBox())?.width).toBe(width)
      await expect(view.getByRole("button", { name: /Devolver para/ })).toBeInViewport()
    }
    const evidence = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: resolve(evidence, `${baseline ? "before" : "after"}-channel-${width}.png`) })
    if (!baseline) {
      await page.goBack()
      await expect(view).toHaveAttribute("data-full-view", "false")
      await expect(composer).toBeVisible()
      await view.getByRole("button", { name: /Devolver para/ }).click()
      await expect(view).toHaveCount(0)
    }
  })
}

test.afterEach(async ({ page }, info) => {
  const evidence = process.env.TOURI_E2E_EVIDENCE_DIR
  const video = page.video()
  if (!evidence || !video) return
  await page.close()
  await video.saveAs(
    resolve(evidence, `${baseline ? "before" : "after"}-${info.title.replace(/[^a-z0-9]+/giu, "-")}.webm`),
  )
})
