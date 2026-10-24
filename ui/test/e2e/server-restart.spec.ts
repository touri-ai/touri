import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
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
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

for (const mode of ["desktop", "web"] as const) {
  test(`${mode} reconnects after a real staging restart in less than 3 seconds without losing the draft`, async ({
    page,
  }, info) => {
    const evidence = resolve(import.meta.dirname, "../../../docs/qa/server-restart")
    await mkdir(evidence, { recursive: true })
    const server = await createServerModeFixture({
      initialMode: "server",
      port: Number(process.env.TOURI_RESTART_TEST_PORT ?? 0),
    })
    servers.add(server)
    if (mode === "web") await page.setViewportSize({ width: 390, height: 844 })
    const settings = await server.api("/settings")
    const { bot } = await server.api("/bots", "POST", {
      name: "Assistente de teste",
      provider: settings.settings.defaultProvider,
    })
    await seedHistory(server.dataDir, bot.mainThreadId)
    if (mode === "desktop") await server.install(page)
    if (mode === "web") {
      const pairing = await page.request.post(`${server.serverUrl}/pair`, {
        headers: { Origin: server.serverUrl },
        data: { code: server.code(), name: "Browser test" },
      })
      expect(pairing.ok()).toBe(true)
      await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
    }
    const navigation = page.waitForResponse((response) => response.url().includes("/messages") && response.ok())
    await page.goto(mode === "desktop" ? server.relayUrl : server.serverUrl)
    await navigation
    const composer = page.getByRole("textbox", { name: "Mensagem para Assistente de teste" })
    await expect(composer).toBeVisible()
    await composer.fill("Rascunho fictício: continuar depois da atualização.")
    const scroll = page.locator(".message-scroll")
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(100)
    await scroll.evaluate((element) => {
      element.scrollTop = 120
    })
    const previousScroll = await scroll.evaluate((element) => element.scrollTop)
    const originalComposer = await composer.elementHandle()
    const document = await page.locator("html").elementHandle()
    const snapshots: string[] = []
    page.on("request", (request) => {
      if (/\/api\/v1\/(bots(?:\?|$)|threads\/[^/]+\/(messages|transcript))/.test(request.url()))
        snapshots.push(request.url())
    })
    let failedHealthReads = 0
    page.on("response", (response) => {
      if (response.url().endsWith("/health") && response.status() === 503) failedHealthReads++
    })
    page.on("requestfailed", (request) => {
      if (request.url().endsWith("/health")) failedHealthReads++
    })
    const status = page.locator('[data-connection-state="reconnecting"]')

    await server.stop()
    await expect(status).toBeVisible()
    await expect(status).toHaveAttribute("data-connection-reason", "unavailable")
    await expect(status).toContainText(/Tentativa \d+/)
    await expect(composer).toHaveValue("Rascunho fictício: continuar depois da atualização.")
    await info.attach(`${mode}-reconnecting`, {
      body: await page.screenshot({ path: resolve(evidence, `${mode}-reconnecting.png`) }),
      contentType: "image/png",
    })
    // Reach the capped retry interval before making the server available again.
    await expect.poll(() => failedHealthReads, { timeout: 15_000 }).toBeGreaterThanOrEqual(4)
    expect(Number(await status.getAttribute("data-connection-attempt"))).toBeGreaterThan(1)
    const readyAt = await server.start()
    await expect(status).toBeHidden({ timeout: 2900 })
    await expect(page.locator(".connection-status")).toHaveCount(0)
    const reconnectMs = performance.now() - readyAt

    expect(reconnectMs).toBeLessThan(3000)
    await expect(composer).toHaveValue("Rascunho fictício: continuar depois da atualização.")
    expect(await originalComposer?.evaluate((element) => element.isConnected)).toBe(true)
    expect(await document?.evaluate((element) => element.isConnected)).toBe(true)
    expect(await scroll.evaluate((element) => element.scrollTop)).toBe(previousScroll)
    expect(snapshots).toEqual([])
    // A post-restart event proves the new stream is live and the original auth still works.
    await server.api(`/bots/${bot.id}`, "PATCH", { name: "Assistente reconectado" })
    await expect(page.getByRole("textbox", { name: "Mensagem para Assistente reconectado" })).toHaveValue(
      "Rascunho fictício: continuar depois da atualização.",
    )
    await info.attach(`${mode}-recovered`, {
      body: await page.screenshot({ path: resolve(evidence, `${mode}-recovered.png`) }),
      contentType: "image/png",
    })
    await info.attach(`${mode}-restart-timing`, {
      body: JSON.stringify({
        mode,
        reconnectMs,
        scrollTop: previousScroll,
        snapshotReads: snapshots.length,
        draftKept: true,
      }),
      contentType: "application/json",
    })
    console.log(
      JSON.stringify({ mode, reconnectMs, draftKept: true, scrollKept: true, snapshotReads: snapshots.length }),
    )
  })
}

const seedHistory = (dataDir: string, threadId: string): Promise<void> =>
  new Promise((done, reject) => {
    const child = spawn("bun", [resolve(import.meta.dirname, "reconnect-history-fixture.ts"), dataDir, threadId], {
      stdio: "ignore",
      timeout: 15_000,
      killSignal: "SIGKILL",
    })
    child.once("error", reject)
    child.once("exit", (code) => (code === 0 ? done() : reject(new Error("Could not seed synthetic conversation"))))
  })
