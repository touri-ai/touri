import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { test as base, expect, type Page } from "@playwright/test"
import { build, preview } from "vite"

const test = base.extend<object, { conversationApp: string }>({
  conversationApp: [
    async ({ browserName }, use) => {
      const root = resolve(import.meta.dirname, "../..")
      const outDir = await mkdtemp(resolve(tmpdir(), `touri-lazy-chat-${browserName}-`))
      const server = await startConversationServer(root, outDir)

      await use(`${server.resolvedUrls?.local[0]}test/e2e/work-mode-harness.html`)
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(outDir, { recursive: true, force: true })
    },
    { scope: "worker", timeout: 180_000 },
  ],
})

const startConversationServer = async (root: string, outDir: string) => {
  await build({
    root,
    build: {
      outDir,
      reportCompressedSize: false,
      rollupOptions: { input: resolve(root, "test/e2e/work-mode-harness.html") },
    },
  })

  for (const offset of Array.from({ length: 100 }, (_, index) => index)) {
    const port = 18800 + ((process.pid + offset) % 100)
    try {
      return await preview({ root, build: { outDir }, preview: { host: "127.0.0.1", port, strictPort: true } })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already in use")) throw error
    }
  }

  throw new Error("No free conversation preview port")
}

const chunkPattern = "**/assets/ChatPanel-*.js"
const getComposer = (page: Page) => page.getByRole("textbox", { name: "Mensagem para mark", exact: true })

const captureEvidence = async (page: Page, name: string) => {
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: resolve(directory, `${name}.png`) })
}

test("keeps cached conversations responsive across mode and channel switches", async ({ page, conversationApp }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
  await page.goto(conversationApp)
  await expect(getComposer(page)).toBeVisible()
  await page
    .getByRole("region", { name: "Canais" })
    .getByRole("button", { name: /^Planejamento(?:,|$)/ })
    .click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento", exact: true })).toBeVisible()
  await page.locator('[data-work-bot-entry="bot-mark"] .bot-row-main').click()
  await expect(getComposer(page)).toBeVisible()

  await page.evaluate(() => {
    let samples: number[] = []
    let longTasks = 0
    let cls = 0
    const tasks = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length
    })
    const shifts = new PerformanceObserver((list) => {
      const entries = list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>
      cls += entries.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0)
    })
    const recordClick = (event: MouseEvent) => {
      const selector = ".sidebar-mode-tabs button, .group-select, [data-work-bot-entry] .bot-row-main"
      if (!(event.target instanceof Element) || !event.target.closest(selector)) return
      const start = performance.now()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          samples = samples.concat(performance.now() - start)
        }),
      )
    }
    tasks.observe({ type: "longtask" })
    shifts.observe({ type: "layout-shift" })
    document.addEventListener("click", recordClick, true)
    Object.assign(window, {
      getConversationNavigationMetrics: () => {
        const ordered = samples.toSorted((left, right) => left - right)

        return { samples: samples.length, p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], longTasks, cls }
      },
      stopConversationNavigationMetrics: () => {
        tasks.disconnect()
        shifts.disconnect()
        document.removeEventListener("click", recordClick, true)
      },
    })
  })
  const selectors = [
    "#sidebar-mode-bots",
    "#sidebar-mode-work",
    ".group-select",
    '[data-work-bot-entry="bot-mark"] .bot-row-main',
  ]
  for (const index of Array.from({ length: 40 }, (_, index) => index)) {
    await page
      .locator(selectors[index % selectors.length] ?? "")
      .first()
      .click()
  }
  const metrics = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const target = window as Window & {
      getConversationNavigationMetrics: () => { samples: number; p95Ms: number; longTasks: number; cls: number }
      stopConversationNavigationMetrics: () => void
    }
    const metrics = target.getConversationNavigationMetrics()
    target.stopConversationNavigationMetrics()

    return metrics
  })

  console.log("Cached conversation navigation", JSON.stringify(metrics))
  await test
    .info()
    .attach("conversation-navigation.json", { body: JSON.stringify(metrics), contentType: "application/json" })
  await expect(getComposer(page)).toBeVisible()
  expect(metrics.samples).toBe(40)
  expect(metrics.p95Ms).toBeLessThan(100)
  expect(metrics.longTasks).toBe(0)
  expect(metrics.cls).toBeLessThan(0.01)
})

for (const width of [1440, 390]) {
  test(`recovers a failed conversation import in Work mode at ${width}px`, async ({ page, conversationApp }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
    await page.goto(conversationApp)
    await getComposer(page).fill("Rascunho sintético para recuperação")
    // Block the initial import, including its preload, until the recovery control appears.
    await page.route(chunkPattern, (route) => route.abort("failed"))

    await page.reload()
    const retry = page.getByRole("button", { name: "Recarregar esta área", exact: true })
    await expect(retry).toBeVisible()
    await captureEvidence(page, `lazy-chat-before-${width}`)
    await page.unroute(chunkPattern)
    let navigations = 0
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1
    })
    await retry.click()

    await expect(getComposer(page)).toHaveValue("Rascunho sintético para recuperação")
    expect(navigations).toBe(0)
    await captureEvidence(page, `lazy-chat-after-${width}`)
  })
}

test("reloads the app after a second import failure and restores the draft", async ({ page, conversationApp }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
  await page.goto(conversationApp)
  await getComposer(page).fill("Rascunho sintético após recarregar")
  await page.route(chunkPattern, (route) => route.abort("failed"))
  await page.reload()

  await page.getByRole("button", { name: "Recarregar esta área", exact: true }).click()

  const reload = page.getByRole("button", { name: "Recarregar app", exact: true })
  await expect(reload).toBeInViewport()
  await captureEvidence(page, "lazy-chat-reload-390")
  await page.unroute(chunkPattern)
  await reload.click()
  await expect(getComposer(page)).toHaveValue("Rascunho sintético após recarregar")
})
