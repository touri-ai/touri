import { expect, type Locator, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

// Inside the conversation's own visible area and on top: not clipped by the history, not covered.
const getPlacement = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const list = document.querySelector(".message-scroll")?.getBoundingClientRect()
    const viewport = window.visualViewport
    const top = Math.max(list?.top ?? 0, viewport?.offsetTop ?? 0)
    const bottom = Math.min(list?.bottom ?? 0, viewport ? viewport.offsetTop + viewport.height : window.innerHeight)
    return {
      withinHistory: Boolean(list && box.top >= top - 1 && box.bottom <= bottom + 1),
      hittable: [box.top + 1, box.bottom - 1].every((y) => {
        const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
        return hit !== null && element.contains(hit)
      }),
    }
  })

for (const history of ["short", "long"] as const)
  test(`active take-over keeps its handback reachable after resizing to a phone (${history} conversation)`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/test/e2e/browser-outcome-harness.html?takeover=live${history === "long" ? "&long=1" : ""}`)
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill("Rascunho que deve continuar aqui")
    const takeOver = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeOver).toBeEnabled({ timeout: 20_000 })
    await takeOver.dispatchEvent("click")

    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(view.getByRole("img")).toBeVisible({ timeout: 20_000 })
    const handback = view.getByRole("button", { name: "Devolver para mark", exact: true })
    await expect.poll(() => getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({
        mask: [page.locator(".composer-model")],
        maskColor: "#28282b",
        path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-${history}-1440.png`,
      })

    // The same session moves to a phone-sized window; nothing in the test scrolls the history.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({
        mask: [page.locator(".composer-model")],
        maskColor: "#28282b",
        path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-resized-${history}-390.png`,
      })
    await expect.poll(() => getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })
    await expect
      .poll(() => getPlacement(view.getByRole("status", { name: "Privacidade do navegador" })))
      .toEqual({ withinHistory: true, hittable: true })

    // Focusing the keyboard entry on the phone must not hide the handback either.
    await view.getByRole("button", { name: "Digitar no navegador" }).dispatchEvent("click")
    await expect.poll(() => getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })

    await handback.dispatchEvent("click")
    await expect(view).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as Window & { browserOutcome?: { releases: string[] } }).browserOutcome?.releases,
      ),
    ).toEqual(["browser-outcome-tab"])
    await expect(input).toHaveValue("Rascunho que deve continuar aqui")
  })

test("a visual viewport resize keeps the handback above the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/browser-outcome-harness.html?takeover=live&long=1")
  const takeOver = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
  await expect(takeOver).toBeEnabled({ timeout: 20_000 })
  await takeOver.dispatchEvent("click")
  const handback = page.getByRole("button", { name: "Devolver para mark", exact: true })
  await expect.poll(() => getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })
  const history = page.locator(".message-scroll")
  const area = await history.boundingBox()
  if (!area) throw new Error("Missing conversation history")
  await page.mouse.move(area.x + 2, area.y + area.height / 2)
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => (await handback.boundingBox())?.y ?? 0).toBeGreaterThan(300)

  await page.evaluate(() => {
    const viewport = window.visualViewport
    if (!viewport) throw new Error("Missing visual viewport")
    Object.defineProperty(viewport, "height", { configurable: true, value: 300 })
    viewport.dispatchEvent(new Event("resize"))
  })

  await expect.poll(() => getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })
})

test("resizing preserves the position of a person reading away from the controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/browser-outcome-harness.html?takeover=live&long=1")
  const takeOver = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
  await expect(takeOver).toBeEnabled({ timeout: 20_000 })
  await takeOver.dispatchEvent("click")
  const handback = page.getByRole("button", { name: "Devolver para mark", exact: true })
  await expect.poll(() => getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })
  await page.locator(".message-scroll").hover()
  await page.mouse.wheel(0, -900)
  await expect.poll(async () => (await getPlacement(handback)).withinHistory).toBe(false)

  await page.setViewportSize({ width: 1440, height: 844 })
  // Let layout, resize listeners and the ensuing scroll settle before checking intentional reading.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  expect((await getPlacement(handback)).withinHistory).toBe(false)
})
