import { expect, test } from "@playwright/test"
import { createServerModeFixture } from "./server-mode-fixture"

type Server = Awaited<ReturnType<typeof createServerModeFixture>>
const servers = new Set<Server>()
const widths = [1440, 390]
test.setTimeout(120_000)
test.afterEach(async () => {
  for (const server of servers) await server.dispose()
  servers.clear()
})

widths.forEach((width) => {
  test(`a protocol mismatch offers one readable primary recovery action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const server = await createServerModeFixture({
      initialMode: "server",
      port: Number(process.env.TOURI_RESTART_TEST_PORT ?? 0),
    })
    servers.add(server)
    await server.install(page)
    await page.route("**/api/v1/health", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ errorCode: "SERVER_VERSION_MISMATCH", code: "TOURI-E1009" }),
      }),
    )

    await page.goto(server.relayUrl)

    const notice = page.locator('[data-connection-state="incompatible"]')
    const update = page.getByRole("button", { name: "Atualizar agora" })
    await expect(update).toBeVisible()
    await expect(update).toHaveClass(/button-brand/)
    await expect(page.getByText("Servidor offline. Tentando reconectar…")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Tentar novamente/ })).toHaveCount(0)
    const noticeBounds = await notice.boundingBox()
    const buttonBounds = await update.boundingBox()
    if (!noticeBounds || !buttonBounds) throw new Error("Recovery action must have visible bounds")
    expect(buttonBounds.x).toBeGreaterThanOrEqual(noticeBounds.x)
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(noticeBounds.x + noticeBounds.width)
    expect(await update.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    await update.focus()
    await page.keyboard.press("Enter")

    await expect.poll(() => server.commands.filter((command) => command === "updater_install").length).toBe(1)
  })
})
