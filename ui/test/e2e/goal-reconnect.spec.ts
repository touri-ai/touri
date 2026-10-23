import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]

viewports.forEach((viewport) => {
  test(`an ordinary conversation recovers optional goal reads at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.route("**/goal-read", (route) => route.fulfill({ status: 404, body: "Starting" }))
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/goal-read") && response.status() === 404),
      page.goto("/test/e2e/goal-reconnect-harness.html"),
    ])
    const composer = page.getByRole("textbox", { name: "Mensagem para Aurora QA" })
    await expect(composer).toBeVisible()
    const draft = "Rascunho de QA preservado durante a reconexão."
    await composer.fill(draft)
    const history = await page.locator(".message-bubble").allTextContents()

    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/goal-read") && response.status() === 404),
      page.evaluate(() => window.dispatchEvent(new Event("goal-reconnect"))),
    ])
    await page.unroute("**/goal-read")
    await page.route("**/goal-read", (route) => route.fulfill({ status: 200, body: '{"goal":null}' }))
    await page.waitForResponse((response) => response.url().endsWith("/goal-read") && response.status() === 200)

    await expect(page.locator(".goal-panel")).toHaveCount(0)
    await expect(composer).toHaveValue(draft)
    expect(await page.locator(".message-bubble").allTextContents()).toEqual(history)
    const directory = process.env.TOURI_GOAL_RECONNECT_SHOTS_DIR
    if (!directory) return

    await page.screenshot({
      path: `${directory}/after-${viewport.width}.png`,
      mask: [page.locator(".composer-model")],
      animations: "disabled",
    })
  })
})
