import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect, type JSHandle, type Page, type Request } from "@playwright/test"
import { build, preview } from "vite"

const test = base.extend<{ failDraftStorage: () => Promise<void> }, { conversationApp: string }>({
  failDraftStorage: async ({ page }, use) => {
    // The browser owns this patch; the fixture keeps its restore handle for teardown.
    let restore: JSHandle<() => void> | undefined
    await use(async () => {
      restore = await installDraftStorageFailure(page)
    })
    await restore?.evaluate((restore) => restore())
  },
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
    expect((await new AxeBuilder({ page }).include(".render-error").analyze()).violations).toEqual([])
    await captureEvidence(page, `lazy-chat-before-${width}`)
    await page.unroute(chunkPattern)
    let navigations = 0
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1
    })
    await retry.focus()
    await page.keyboard.press("Enter")

    await expect(getComposer(page)).toHaveValue("Rascunho sintético para recuperação")
    expect(navigations).toBe(0)
    await captureEvidence(page, `lazy-chat-after-${width}`)
  })
}

for (const width of [1440, 390]) {
  test(`reloads the app after a second import failure and restores the draft at ${width}px`, async ({
    page,
    conversationApp,
  }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
    await page.goto(conversationApp)
    await getComposer(page).fill("Rascunho sintético após recarregar")
    await page.route(chunkPattern, (route) => route.abort("failed"))
    await page.reload()

    await page.getByRole("button", { name: "Recarregar esta área", exact: true }).click()

    const reload = page.getByRole("button", { name: "Recarregar app", exact: true })
    await expect(reload).toBeInViewport()
    expect((await new AxeBuilder({ page }).include(".render-error").analyze()).violations).toEqual([])
    await captureEvidence(page, `lazy-chat-reload-${width}`)
    await page.unroute(chunkPattern)
    await reload.click()
    await expect(getComposer(page)).toHaveValue("Rascunho sintético após recarregar")
    await captureEvidence(page, `lazy-chat-reloaded-${width}`)
  })
}

for (const width of [1440, 390]) {
  test(`automatically recovers stale styles without losing a saved draft at ${width}px`, async ({
    page,
    conversationApp,
  }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
    await page.goto(conversationApp)
    await getComposer(page).fill("Rascunho sintético após atualizar")
    const stylesheet = "**/assets/ChatPanel-*.css"
    await page.route(stylesheet, (route) => route.abort("failed"))

    await page.reload()
    await expect(page.getByRole("button", { name: "Recarregar esta área", exact: true })).toBeVisible()
    await captureEvidence(page, `stale-assets-before-${width}`)
    await page.unroute(stylesheet)
    await page.route(stylesheet, (route) => route.abort("failed"), { times: 1 })
    // Browser callbacks append to a local observation log to count full-page navigations.
    const navigations: string[] = []
    page.on("request", (request) => {
      if (isDocumentNavigation(request, page)) navigations.push(request.url())
    })

    await page.goto(`${conversationApp}?assetRecovery`)

    await expect(getComposer(page)).toHaveValue("Rascunho sintético após atualizar")
    expect(navigations).toHaveLength(2)
    await captureEvidence(page, `stale-assets-after-${width}`)
    expect((await new AxeBuilder({ page }).include(".composer").analyze()).violations).toEqual([])
  })
}

test("exposes persistent asset failures after exactly one automatic reload", async ({ page, conversationApp }) => {
  test.setTimeout(90_000)
  await page.route("**/assets/ChatPanel-*.css", (route) => route.abort("failed"))
  // Browser callbacks append to a local observation log to count full-page navigations.
  const navigations: string[] = []
  page.on("request", (request) => {
    if (isDocumentNavigation(request, page)) navigations.push(request.url())
  })

  await page.goto(`${conversationApp}?assetRecovery`)

  await expect(page.getByRole("button", { name: "Recarregar esta área", exact: true })).toBeVisible()
  expect(navigations).toHaveLength(2)
  expect(await page.evaluate(() => sessionStorage.getItem("touri.lazy-asset-recovery"))).toBe("1")
})

test("keeps an unsaved draft when local storage fails and a preload error occurs", async ({
  page,
  conversationApp,
  failDraftStorage,
}) => {
  test.setTimeout(90_000)
  await page.goto(`${conversationApp}?assetRecovery`)
  await expect(getComposer(page)).toBeVisible()
  await failDraftStorage()
  await getComposer(page).fill("Texto sintético mantido na memória")
  const navigated = page
    .waitForRequest((request) => isDocumentNavigation(request, page), { timeout: 1_000 })
    .then(
      () => true,
      () => false,
    )

  const prevented = await page.evaluate(() => {
    const failure = new Event("vite:preloadError", { cancelable: true })
    window.dispatchEvent(failure)

    return failure.defaultPrevented
  })

  expect(prevented).toBe(false)
  expect(await navigated).toBe(false)
  await expect(getComposer(page)).toHaveValue("Texto sintético mantido na memória")
  await expect(page.locator('[data-unsaved-draft="true"]')).toBeVisible()
})

test("keeps a pending attachment when a preload error occurs", async ({ page, conversationApp }) => {
  test.setTimeout(90_000)
  await page.goto(`${conversationApp}?assetRecovery`)
  await expect(getComposer(page)).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic attachment"),
  })
  await expect(page.locator(".attachment-strip li")).toBeVisible()
  const navigated = page
    .waitForRequest((request) => isDocumentNavigation(request, page), { timeout: 1_000 })
    .then(
      () => true,
      () => false,
    )

  const prevented = await page.evaluate(() => {
    const failure = new Event("vite:preloadError", { cancelable: true })
    window.dispatchEvent(failure)

    return failure.defaultPrevented
  })

  expect(prevented).toBe(false)
  expect(await navigated).toBe(false)
  await expect(page.locator(".attachment-strip li")).toContainText("synthetic-note.txt")
})

test("keeps the loaded conversation when an asset fails while offline", async ({ page, conversationApp }) => {
  test.setTimeout(90_000)
  await page.goto(`${conversationApp}?assetRecovery`)
  await getComposer(page).fill("Rascunho sintético sem rede")
  await page.context().setOffline(true)

  const prevented = await page.evaluate(() => {
    const failure = new Event("vite:preloadError", { cancelable: true })
    window.dispatchEvent(failure)

    return failure.defaultPrevented
  })

  expect(prevented).toBe(false)
  await expect(getComposer(page)).toHaveValue("Rascunho sintético sem rede")
})

const isDocumentNavigation = (request: Request, page: Page): boolean =>
  request.isNavigationRequest() && request.frame() === page.mainFrame()

const installDraftStorageFailure = (page: Page) =>
  page.evaluateHandle(() => {
    const setItem = Storage.prototype.setItem
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(this: Storage, key: string, value: string) {
        if (this === localStorage && key.includes("touri.composer-draft.v1:")) {
          throw new DOMException("Synthetic storage failure", "QuotaExceededError")
        }
        setItem.call(this, key, value)
      },
    })

    return () => Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value: setItem })
  })
