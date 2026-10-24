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

const scenarios = [false, true].flatMap((channel) => [1440, 390].map((width) => ({ channel, width })))
for (const { channel, width } of scenarios) {
  test(`selected history renders before held run metadata in ${channel ? "channel" : "bot"} at ${width}px`, async ({
    page,
  }, info) => {
    const server = await createServerModeFixture({ port: 18867 })
    servers.add(server)
    const settings = await server.api("/settings")
    const { bot } = await server.api("/bots", "POST", {
      name: "Brisa fictícia",
      provider: settings.settings.defaultProvider,
    })
    const conversation = channel
      ? await server.api("/groups", "POST", {
          name: "Canal fictício",
          color: "#558866",
          avatarShape: "cercle",
          memberIds: [bot.id],
          coordinatorBotId: null,
        })
      : { thread: { id: bot.mainThreadId } }
    const threadId = conversation.thread.id
    const recipient = channel ? "Canal fictício" : "Brisa fictícia"
    await server.stop()
    await seedHistory(server.dataDir, threadId)
    await server.start()
    await server.install(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    const runResponse = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const before = process.env.SELECTED_HISTORY_PHASE === "before"
    const times: Record<string, number> = {}
    await page.addInitScript(() => {
      const timingWindow = window as Window & { selectedHistoryDomMs?: number }
      const observer = new MutationObserver(() => {
        const message = document.querySelector('[data-message-id="restart-history-59"]')
        if (!message?.getBoundingClientRect().height) return

        timingWindow.selectedHistoryDomMs = performance.now()
        observer.disconnect()
      })
      observer.observe(document, { childList: true, subtree: true })
    })
    await page.route(`**/api/v1/threads/${threadId}/runs*`, async (route) => {
      const response = await route.fetch()
      runResponse.resolve()
      await release.promise
      await route.fulfill({ response })
    })
    page.on("response", (response) => {
      if (response.url().includes(`/threads/${threadId}/messages`) && response.ok())
        times.messagesResponseMs = performance.now()
    })
    const started = performance.now()
    await page.goto(server.relayUrl)
    if (channel) {
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await page.getByRole("tab", { name: /^Work,/ }).click()
      await page.getByRole("region", { name: "Canais", exact: true }).getByText(recipient, { exact: true }).click()
    }
    await runResponse.promise
    const message = page.locator('[data-message-id="restart-history-59"]')
    const composer = page.getByRole("textbox", { name: `Mensagem para ${recipient}`, exact: true })
    await expect.poll(() => times.messagesResponseMs).toBeGreaterThan(0)
    if (before) {
      await expect(page.getByRole("status", { name: "Carregando conversas…" })).toBeVisible()
      await expect(message).toBeHidden()
    } else {
      await expect(message).toBeVisible({ timeout: 1000 })
      await expect(composer).toBeVisible()
      await composer.fill("Rascunho fictício preservado.")
    }
    const observed = performance.now()
    if (channel && width === 1440)
      await expect(page.locator(".sidebar-footer .user-chip strong")).toHaveText("Pessoa demo")
    const imageName = `selected-history-${channel ? "channel-" : ""}${before ? "before" : "after"}-${width}.png`
    const imagePath = info.outputPath(imageName)
    await info.attach(imageName, {
      body: await page.screenshot({
        path: imagePath,
        // The environment's provider choice is unrelated to the history evidence.
        mask: [page.locator(".model-picker-trigger-label")],
        maskColor: "#dddde2",
      }),
      contentType: "image/png",
    })
    if (process.env.TOURI_EVIDENCE_DIR) await copyFile(imagePath, resolve(process.env.TOURI_EVIDENCE_DIR, imageName))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (!before) await expect(composer).toHaveValue("Rascunho fictício preservado.")
    release.resolve()
    await expect(message).toBeVisible()
    if (before) await composer.fill("Rascunho fictício preservado.")
    await expect(composer).toHaveValue("Rascunho fictício preservado.")
    const domTiming = await page.evaluate((threadId) => {
      const timingWindow = window as Window & { selectedHistoryDomMs?: number }
      const response = performance
        .getEntriesByType("resource")
        .find((entry) => entry.name.includes(`/threads/${threadId}/messages`)) as PerformanceResourceTiming | undefined
      const historyDomMs = timingWindow.selectedHistoryDomMs ?? null

      return {
        navigationToHistoryDomMs: historyDomMs,
        messagesResponseToHistoryDomMs: historyDomMs !== null && response ? historyDomMs - response.responseEnd : null,
      }
    }, threadId)
    const metrics = {
      ...domTiming,
      width,
      surface: channel ? "channel" : "bot",
      phase: before ? "before" : "after",
      navigationToObservationMs: observed - started,
      messagesResponseToObservationMs: observed - (times.messagesResponseMs ?? observed),
      historyVisibleWhileRunsHeld: !before,
      workload: "60 synthetic messages; restarted real server; held run response; no production data",
    }
    console.log(JSON.stringify(metrics))
    await info.attach(`selected-history-${width}.json`, {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    })
  })
}

const seedHistory = (dataDir: string, threadId: string): Promise<void> =>
  new Promise((done, reject) => {
    const child = spawn(
      "bun",
      [resolve(import.meta.dirname, "reconnect-history-fixture.ts"), dataDir, threadId, "Pessoa demo"],
      { stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL" },
    )
    child.once("error", reject)
    child.once("exit", (code) => (code === 0 ? done() : reject(new Error("Could not seed synthetic conversation"))))
  })
