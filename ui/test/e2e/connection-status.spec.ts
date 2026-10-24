import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce" })

const viewportWidths = [1440, 390]
viewportWidths.forEach((width) => {
  test(`connection status keeps history, pending messages and the current attempt at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    // Playwright owns this external socket boundary; the app uses its real client, journal and workspace.
    await page.routeWebSocket("**/api/v1/events?*", (socket) => {
      socket.send(JSON.stringify({ type: "resync", lastSeq: 0 }))
    })
    await page.goto("/test/e2e/connection-recovery-harness.html")
    const composer = page.getByRole("textbox", { name: "Mensagem para mark" })
    const conversation = page.getByTestId("virtual-message-list")
    const status = page.locator(".connection-status")
    await expect(status).toHaveAttribute("data-connection-state", "idle")
    await expect(status).toContainText("Este bot não tem tarefa em execução.")
    await expect(conversation.getByText("Histórico de teste preservado.", { exact: true })).toBeVisible()
    const originalComposer = await composer.elementHandle()

    await page.context().setOffline(true)
    await expect(status).toHaveAttribute("data-connection-state", "offline")
    await expect(status).toContainText("Este aparelho está sem internet.")
    await composer.fill("Mensagem pendente de teste.")
    await composer.press("Enter")
    await expect(conversation.getByText("Mensagem pendente de teste.", { exact: true })).toBeVisible()
    await composer.fill("Rascunho preservado.")
    const pending = await page.evaluate(() => window.connectionRecovery.getPending())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.delivery?.status).toBe("queued")

    await page.evaluate(() => window.connectionRecovery.setServerAvailable(false))
    await page.context().setOffline(false)

    await expect(status).toHaveAttribute("data-connection-reason", "unavailable")
    await expect(status).toContainText(/Tentativa \d+ falhou/)
    const attempt = Number(await status.getAttribute("data-connection-attempt"))
    expect(attempt).toBeGreaterThan(1)
    await status.getByRole("button", { name: "Tentar agora" }).click()
    await expect.poll(async () => Number(await status.getAttribute("data-connection-attempt"))).toBeGreaterThan(attempt)
    await expect(status).toContainText("Nova tentativa automática agendada.")
    await expect(composer).toHaveValue("Rascunho preservado.")
    await expect(conversation.getByText("Histórico de teste preservado.", { exact: true })).toBeVisible()

    await page.evaluate(() => window.connectionRecovery.setServerAvailable(true))

    await expect(status).toHaveAttribute("data-connection-state", "idle")
    await expect.poll(() => page.evaluate(() => window.connectionRecovery.getPending().length)).toBe(0)
    const sends = await page.evaluate(() => window.connectionRecovery.getSends())
    expect(sends).toHaveLength(1)
    expect(sends[0]?.clientNonce).toBe(pending[0]?.delivery?.clientNonce)
    expect(sends[0]?.deadline).toBe(pending[0]?.delivery?.deadline)
    await expect(conversation.getByText("Mensagem pendente de teste.", { exact: true })).toHaveCount(1)
    await expect(composer).toHaveValue("Rascunho preservado.")
    expect(await originalComposer?.evaluate((element) => element.isConnected)).toBe(true)
    expect(await status.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })
})

test("revoked access preserves the open conversation and pending message until pairing is explicitly checked", async ({
  page,
}) => {
  await page.routeWebSocket("**/api/v1/events?*", (socket) => {
    socket.send(JSON.stringify({ type: "resync", lastSeq: 0 }))
  })
  await page.goto("/test/e2e/connection-recovery-harness.html")
  const composer = page.getByRole("textbox", { name: "Mensagem para mark" })
  const conversation = page.getByTestId("virtual-message-list")
  const status = page.locator(".connection-status")
  await expect(status).toHaveAttribute("data-connection-state", "idle")
  await page.context().setOffline(true)
  await expect(status).toHaveAttribute("data-connection-state", "offline")
  await composer.fill("Mensagem que aguarda novo acesso.")
  await composer.press("Enter")
  await composer.fill("Rascunho durante revogação.")
  const pending = await page.evaluate(() => window.connectionRecovery.getPending())

  await page.evaluate(() => window.connectionRecovery.setSessionAccepted(false))
  await page.context().setOffline(false)

  await expect(status).toHaveAttribute("data-connection-state", "session-expired")
  await expect(status).toContainText("A sessão expirou ou o acesso foi revogado.")
  await expect(status.getByRole("link", { name: "Parear novamente" })).toHaveAttribute("href", "/login")
  await expect(status.getByRole("link", { name: "Parear novamente" })).toHaveAttribute("target", "_blank")
  await expect(composer).toHaveValue("Rascunho durante revogação.")
  await expect(conversation.getByText("Histórico de teste preservado.", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.connectionRecovery.getPending())).toEqual(pending)
  const requests = await page.evaluate(() => window.connectionRecovery.getRequests())

  await page.evaluate(() => {
    window.connectionRecovery.setSessionAccepted(true)
    window.dispatchEvent(new Event("online"))
    document.dispatchEvent(new Event("visibilitychange"))
  })

  await expect(status).toHaveAttribute("data-connection-state", "session-expired")
  expect(await page.evaluate(() => window.connectionRecovery.getSends())).toEqual([])
  expect(await page.evaluate(() => window.connectionRecovery.getRequests())).toBe(requests)

  await status.getByRole("button", { name: "Verificar acesso" }).click()

  await expect(status).toHaveAttribute("data-connection-state", "idle")
  await expect.poll(() => page.evaluate(() => window.connectionRecovery.getPending().length)).toBe(0)
  await expect(conversation.getByText("Mensagem que aguarda novo acesso.", { exact: true })).toHaveCount(1)
  await expect(composer).toHaveValue("Rascunho durante revogação.")
  await expect(conversation.getByText("Histórico de teste preservado.", { exact: true })).toBeVisible()
})

test("reopening the app restores the offline journal and draft without duplicating the message", async ({ page }) => {
  await page.routeWebSocket("**/api/v1/events?*", (socket) => {
    socket.send(JSON.stringify({ type: "resync", lastSeq: 0 }))
  })
  await page.goto("/test/e2e/connection-recovery-harness.html")
  const composer = page.getByRole("textbox", { name: "Mensagem para mark" })
  const conversation = page.getByTestId("virtual-message-list")
  await expect(page.locator('[data-connection-state="idle"]')).toBeVisible()
  await page.context().setOffline(true)
  await expect(page.locator('[data-connection-state="offline"]')).toBeVisible()
  await composer.fill("Envio que sobrevive ao reinício da interface.")
  await composer.press("Enter")
  await expect(conversation.getByText("Envio que sobrevive ao reinício da interface.", { exact: true })).toBeVisible()
  await composer.fill("Rascunho salvo antes do reinício.")
  const pending = await page.evaluate(() => window.connectionRecovery.getPending())
  await page.evaluate(() => window.connectionRecovery.setServerAvailable(false))
  // Restoring networking lets the next document load; the old document still cannot send.
  await page.context().setOffline(false)
  await page.reload()

  await expect(page.locator('[data-connection-state="idle"]')).toBeVisible()
  await expect(composer).toHaveValue("Rascunho salvo antes do reinício.")
  await expect(conversation.getByText("Histórico de teste preservado.", { exact: true })).toBeVisible()
  await expect(conversation.getByText("Envio que sobrevive ao reinício da interface.", { exact: true })).toHaveCount(1)
  const sends = await page.evaluate(() => window.connectionRecovery.getSends())
  expect(sends).toHaveLength(1)
  expect(sends[0]?.clientNonce).toBe(pending[0]?.delivery?.clientNonce)
  expect(sends[0]?.deadline).toBe(pending[0]?.delivery?.deadline)
})
