import { expect, test, type Worker } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })

const cleanups = new Set<() => Promise<unknown>>()
test.afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

for (const width of [1440, 390]) {
  test(`web push is opt-in and explains closed-app delivery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    await page.route("**/api/v1/push", (route) =>
      route.fulfill({ json: { publicKey: "synthetic-public-key", subscribed: false } }),
    )
    await page.goto("/test/e2e/home-harness.html")
    if (width < 500) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Você Local/ }).click()
    const dialog = page.getByRole("dialog", { name: "Configurações", exact: true })

    await dialog.getByRole("tab", { name: "Notificações", exact: true }).click()

    await expect(dialog.getByText("Avisos desativados neste aparelho.", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Ativar neste aparelho", exact: true })).toBeVisible()
    await expect(dialog).toContainText("avisos criptografados")
    await expect(dialog).toContainText("tela de início")
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => Notification.permission)).not.toBe("granted")
  })
}

test("a repeated push stays deduplicated without an active OS notification", async ({ page, context }) => {
  await context.grantPermissions(["notifications"])
  await page.goto("/test/e2e/home-harness.html")
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/push-worker.js", { scope: "/" })
    await navigator.serviceWorker.ready
  })
  const worker = context.serviceWorkers()[0]
  expect(worker).toBeDefined()
  if (!worker) return
  const probe = await installDeliveryProbe(worker)
  cleanups.add(probe.restore)

  await worker.evaluate('showPushOnce({ id: 4242 }, { body: "Aviso fictício", tag: "touri-4242" })')
  const first = await probe.getCount()
  await worker.evaluate('showPushOnce({ id: 4242 }, { body: "Aviso fictício", tag: "touri-4242" })')
  const repeated = await probe.getCount()

  expect(first).toBe(1)
  expect(repeated).toBe(1)
})

const installDeliveryProbe = async (worker: Worker) => {
  // Headless OS delivery is inconsistent; keep real IndexedDB and replace only the external display API.
  await worker.evaluate(`(() => {
    const original = self.registration.showNotification.bind(self.registration)
    const count = { value: 0 }
    self.registration.showNotification = async () => { count.value += 1 }
    self.touriPushProbe = {
      getCount: () => count.value,
      restore: () => { self.registration.showNotification = original },
    }
  })()`)

  return {
    getCount: () => worker.evaluate<number>("self.touriPushProbe.getCount()"),
    restore: () => worker.evaluate("self.touriPushProbe.restore()"),
  }
}
