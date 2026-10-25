import { spawn } from "node:child_process"
import { copyFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { createServerModeFixture } from "./server-mode-fixture"

type Server = Awaited<ReturnType<typeof createServerModeFixture>>
const servers = new Set<Server>()
test.afterEach(async () => {
  for (const server of servers) await server.dispose()
  servers.clear()
})
test.setTimeout(240_000)

for (const width of [1440, 390]) {
  test(`5k channel history opens at the bottom, caches switches and preserves older-page position at ${width}px`, async ({
    page,
  }, info) => {
    const server = await createServerModeFixture({ port: Number(process.env.HISTORY_EVIDENCE_PORT ?? 18883) })
    servers.add(server)
    const { settings } = await server.api("/settings")
    const { bot } = await server.api("/bots", "POST", { name: "Brisa fictícia", provider: settings.defaultProvider })
    const groups = await Promise.all(
      ["Plano fictício", "Avisos fictícios"].map((name) =>
        server.api("/groups", "POST", {
          name,
          color: "#558866",
          avatarShape: "cercle",
          memberIds: [bot.id],
          coordinatorBotId: null,
        }),
      ),
    )
    const first = groups[0].thread.id as string
    const second = groups[1].thread.id as string
    await server.stop()
    await seedHistory(server.dataDir, [first, second, bot.mainThreadId])
    await server.start()
    await server.install(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    const before = process.env.HISTORY_PAGINATION_PHASE === "before"
    const reads: Array<{ id: string; count: number; bytes: number }> = []
    page.on("response", async (response) => {
      if (!response.url().includes("/messages") || !response.ok()) return
      const body = await response.text()
      const decoded = JSON.parse(body)
      reads.push({
        id: new URL(response.url()).pathname.split("/").at(-2) ?? "",
        count: decoded.messages.length,
        bytes: body.length,
      })
    })
    await page.goto(server.relayUrl)
    await expect(page.getByRole("textbox", { name: "Mensagem para Brisa fictícia", exact: true })).toBeVisible()
    const showSidebar = async () => {
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    }
    await showSidebar()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    const choose = async (name: string, threadId: string): Promise<number> => {
      await page.evaluate((id) => {
        const timing = window as Window & {
          historyStarted?: number
          historyReady?: number | undefined
          historyLongTasks?: number[]
          historyCls?: number
        }
        timing.historyStarted = performance.now()
        timing.historyReady = undefined
        timing.historyLongTasks = []
        timing.historyCls = 0
        const tasks = new PerformanceObserver((list) =>
          list.getEntries().forEach((entry) => {
            timing.historyLongTasks?.push(entry.duration)
          }),
        )
        tasks.observe({ type: "longtask", buffered: false })
        const shifts = new PerformanceObserver((list) =>
          list.getEntries().forEach((entry) => {
            const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
            if (!shift.hadRecentInput) timing.historyCls = (timing.historyCls ?? 0) + shift.value
          }),
        )
        shifts.observe({ type: "layout-shift", buffered: false })
        const observer = new MutationObserver(() => {
          if (!document.querySelector(`[data-message-id="history-${id}-4999"]`)?.getBoundingClientRect().height) return
          timing.historyReady = performance.now()
          observer.disconnect()
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              tasks.disconnect()
              shifts.disconnect()
            }),
          )
        })
        observer.observe(document, { childList: true, subtree: true })
      }, threadId)
      // Dispatch without hovering first, so a cold switch measures the click path itself.
      await page
        .getByRole("region", { name: "Canais", exact: true })
        .getByText(name, { exact: true })
        .evaluate((element) => {
          const timing = window as Window & { historyStarted?: number }
          timing.historyStarted = performance.now()
          element.closest("button")?.click()
        })
      await expect(page.locator(`[data-message-id="history-${threadId}-4999"]`)).toBeVisible()
      return page.evaluate(() => {
        const timing = window as Window & { historyStarted?: number; historyReady?: number | undefined }
        return (timing.historyReady ?? performance.now()) - (timing.historyStarted ?? performance.now())
      })
    }
    const coldMs = await choose("Plano fictício", first)
    const history = page.getByRole("region", { name: "Histórico da conversa" })
    await expect
      .poll(() => history.evaluate((list) => Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop)))
      .toBeLessThan(3)
    const coldMetrics = await page.evaluate(() => {
      const timing = window as Window & { historyLongTasks?: number[]; historyCls?: number }
      return { longTasks: timing.historyLongTasks ?? [], cls: timing.historyCls ?? 0 }
    })
    const imageName = `history-page-${before ? "before" : "after"}-${width}.png`
    const imagePath = info.outputPath(imageName)
    await page.screenshot({
      path: imagePath,
      mask: [page.locator(".model-picker-trigger-label")],
      maskColor: "#dddde2",
    })
    await info.attach(imageName, { path: imagePath, contentType: "image/png" })
    if (process.env.TOURI_EVIDENCE_DIR) await copyFile(imagePath, resolve(process.env.TOURI_EVIDENCE_DIR, imageName))
    if (!before) {
      await expect.poll(() => reads.find((read) => read.id === first)?.count).toBe(40)
      const olderRequested = Promise.withResolvers<void>()
      const releaseOlder = Promise.withResolvers<void>()
      await page.route(`**/threads/${first}/messages?*before=*`, async (route) => {
        olderRequested.resolve()
        await releaseOlder.promise
        await route.continue()
      })
      await history.evaluate((list) => {
        list.scrollTop = 0
      })
      await olderRequested.promise
      const anchor = await history.evaluate((list) => {
        const viewport = list.getBoundingClientRect()
        const row = Array.from(list.querySelectorAll<HTMLElement>("[data-message-row]")).find((element) => {
          const bounds = element.getBoundingClientRect()
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom
        })
        return { id: row?.dataset.messageRow ?? "", top: (row?.getBoundingClientRect().top ?? 0) - viewport.top }
      })
      expect(anchor.id).not.toBe("")
      releaseOlder.resolve()
      await expect.poll(() => reads.filter((read) => read.id === first).length).toBe(2)
      await expect(page.getByRole("button", { name: "Carregar mensagens anteriores", exact: true })).toBeEnabled()
      await expect.poll(() => history.evaluate((list) => list.scrollTop)).toBeGreaterThan(100)
      await expect(page.locator("[data-message-row]")).toHaveCount(16)
      await expect
        .poll(() =>
          history.evaluate((list, anchor) => {
            const row = Array.from(list.querySelectorAll<HTMLElement>("[data-message-row]")).find(
              (element) => element.dataset.messageRow === anchor.id,
            )
            return row
              ? Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.top)
              : Infinity
          }, anchor),
        )
        .toBeLessThan(2)
    }
    await showSidebar()
    await choose("Avisos fictícios", second)
    const cachedMs: number[] = []
    const readsBeforeCache = reads.length
    for (let index = 0; index < 10; index++) {
      await showSidebar()
      cachedMs.push(await choose(index % 2 ? "Avisos fictícios" : "Plano fictício", index % 2 ? second : first))
    }
    const ordered = Array.from(cachedMs).sort((left, right) => left - right)
    const metrics = {
      phase: before ? "before" : "after",
      width,
      coldMs,
      cachedP95Ms: ordered[9],
      cachedMs,
      ...coldMetrics,
      reads: reads.filter((read) => read.id === first),
      workload: "5000 synthetic messages and 2500 runs per channel/DM; real isolated server",
    }
    console.log(JSON.stringify(metrics))
    await info.attach(`history-budget-${width}.json`, {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    })
    if (!before) {
      expect(reads).toHaveLength(readsBeforeCache)
      expect(coldMs).toBeLessThan(200)
      expect(ordered[9]).toBeLessThan(100)
      expect(coldMetrics.longTasks).toEqual([])
      expect(coldMetrics.cls).toBeLessThan(0.01)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

const seedHistory = (directory: string, threadIds: string[]): Promise<void> =>
  new Promise((done, reject) => {
    const child = spawn(
      "bun",
      [resolve(import.meta.dirname, "history-pagination-fixture.ts"), directory, ...threadIds],
      { stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL" },
    )
    child.once("error", reject)
    child.once("exit", (code) => (code === 0 ? done() : reject(new Error("Could not seed synthetic history"))))
  })
