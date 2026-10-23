import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { showServerSettings } from "./home-navigation"
import { createServerModeFixture } from "./server-mode-fixture"

test.setTimeout(180_000)

test("desktop server mode pairs with a real isolated server and resyncs after a large offline gap", async ({
  page,
}, testInfo) => {
  const server = await createServerModeFixture()
  try {
    const evidence = resolve(import.meta.dirname, "../../../docs/evidence")
    await mkdir(evidence, { recursive: true })
    const settings = (await server.api("/settings")) as { settings: { defaultProvider: string } }
    const created = (await server.api("/bots", "POST", {
      name: "Servidor de teste",
      provider: settings.settings.defaultProvider,
    })) as { bot: { id: string } }
    await server.install(page)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setViewportSize({ width: 1100, height: 800 })
    const frames: Array<{ type?: string; lastSeq?: number }> = []
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          frames.push(JSON.parse(String(payload)))
        } catch {
          // Only the API event socket sends JSON frames.
        }
      })
    })
    await page.goto(server.relayUrl)
    await expect(page.getByRole("textbox", { name: "Mensagem para Servidor de teste" })).toBeVisible()
    await expect.poll(() => server.eventConnections).toBeGreaterThan(0)

    await page.locator(".user-chip").click()
    const dialog = page.getByRole("dialog")
    await showServerSettings(page)
    await expect(dialog.getByText("Usar um servidor touri", { exact: true })).toBeVisible()
    await dialog.getByLabel("Endereço do servidor", { exact: true }).fill(server.serverUrl)
    const pairingCode = server.code()
    const codeInput = dialog.getByLabel("Código de pareamento", { exact: true })
    await expect(codeInput).toHaveAttribute("type", "password")
    await codeInput.fill(pairingCode)
    await dialog.getByRole("button", { name: "Conectar ao servidor", exact: true }).click()
    await expect.poll(() => server.commands.includes("server_mode_pair")).toBe(true)
    await expect(dialog.getByRole("status").filter({ hasText: /reiniciar/i })).toBeVisible()
    await expect(codeInput).toHaveValue("")

    const spent = await fetch(`${server.serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.serverUrl },
      body: JSON.stringify({ code: pairingCode, client: true }),
    })
    expect(spent.status).toBe(401)

    // Model a stalled first server request after the native shell restarts.
    let healthRequests = 0
    let releaseHealth: (() => void) | undefined
    let releaseRetries: (() => void) | undefined
    let lateHealthReleased = false
    const pendingHealth = new Promise<void>((resolve) => {
      releaseHealth = resolve
    })
    const pendingRetries = new Promise<void>((resolve) => {
      releaseRetries = resolve
    })
    await page.route("**/api/v1/health", async (route) => {
      if (++healthRequests !== 1) {
        await pendingRetries
        await route.continue()
        return
      }
      const response = await route.fetch()
      await pendingHealth
      await route.fulfill({ response })
      lateHealthReleased = true
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect.poll(() => healthRequests).toBe(1)
    await expect(page.getByText("Servidor offline. Tentando reconectar…")).toBeVisible({ timeout: 30_000 })
    await testInfo.attach("server-startup-offline", {
      body: await page.screenshot({ path: `${evidence}/server-startup-offline.png` }),
      contentType: "image/png",
    })
    releaseHealth?.()
    await expect.poll(() => lateHealthReleased).toBe(true)
    await expect(page.getByText("Servidor offline. Tentando reconectar…")).toBeVisible()
    releaseRetries?.()
    await expect(page.getByRole("textbox", { name: "Mensagem para Servidor de teste" })).toBeVisible({
      timeout: 10_000,
    })
    expect(healthRequests).toBeGreaterThan(1)
    expect(server.commands).not.toContain("sidecar_restart")
    await testInfo.attach("server-startup-recovered", {
      body: await page.screenshot({ path: `${evidence}/server-startup-recovered.png` }),
      contentType: "image/png",
    })
    await page.unroute("**/api/v1/health")
    await page.locator(".user-chip").click()
    await showServerSettings(page)
    await expect(dialog.getByText("Modo servidor ativo", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Voltar ao modo local", exact: true })).toBeVisible()
    await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click()
    await expect.poll(() => server.connectionTests).toBe(1)
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await testInfo.attach("server-mode-connected", {
      body: await dialog.screenshot({ path: `${evidence}/server-mode-settings.png` }),
      contentType: "image/png",
    })
    await dialog.getByRole("button", { name: "Fechar diálogo", exact: true }).click()

    // A change delivered live proves this is the real event stream before the disconnect.
    await server.api(`/bots/${created.bot.id}`, "PATCH", { name: "Atualizado no servidor" })
    await expect(page.getByRole("textbox", { name: "Mensagem para Atualizado no servidor" })).toBeVisible()
    const connections = server.eventConnections
    const snapshots = server.snapshotReads
    const frameStart = frames.length
    server.pauseEvents()
    await expect(page.locator('[data-connection-state="reconnecting"]')).toBeVisible()
    await testInfo.attach("server-mode-offline", {
      body: await page
        .locator('[data-connection-state="reconnecting"]')
        .screenshot({ path: `${evidence}/server-mode-offline.png` }),
      contentType: "image/png",
    })

    // Three real bot events exceed the server's 2 MiB replay budget without starting any bot.
    for (let revision = 0; revision < 3; revision++) {
      await server.api(`/bots/${created.bot.id}`, "PATCH", {
        name: revision === 2 ? "Retomado no servidor" : "Atualizado no servidor",
        description: `${revision}:${"x".repeat(800_000)}`,
      })
    }
    server.resumeEvents()
    await expect.poll(() => server.eventConnections, { timeout: 15_000 }).toBeGreaterThan(connections)
    await expect(page.getByRole("textbox", { name: "Mensagem para Retomado no servidor" })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('[data-connection-state="reconnecting"]')).toBeHidden()
    expect(
      frames.slice(frameStart).some((frame) => frame.type === "resync" && Number.isSafeInteger(frame.lastSeq)),
    ).toBe(true)
    expect(server.snapshotReads).toBeGreaterThan(snapshots)

    await page.locator(".user-chip").click()
    await showServerSettings(page)
    await dialog.getByRole("button", { name: "Voltar ao modo local", exact: true }).click()
    await expect.poll(() => server.localReturns).toBe(1)
    await expect(dialog.getByRole("status").filter({ hasText: /reiniciar/i })).toBeVisible()
    await page.reload()
    await expect(page.locator(".user-chip")).toHaveAccessibleName("Você")
    await expect(page.getByRole("textbox", { name: "Mensagem para Retomado no servidor" })).toBeVisible()
    await page.locator(".user-chip").click()
    await showServerSettings(page)
    await expect(dialog.getByLabel("Código de pareamento", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Voltar ao modo local", exact: true })).toHaveCount(0)
    // The one-time pairing code must not survive the settings flow in browser storage.
    const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
    expect(JSON.stringify(stored)).not.toContain(pairingCode)
  } finally {
    await server.dispose()
  }
})
