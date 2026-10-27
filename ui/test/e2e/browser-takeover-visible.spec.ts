import { expect, type Locator, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

// Fully on screen and on top: not scrolled away and not hidden under another layer.
const isUncovered = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return [box.top + 1, box.bottom - 1].every((y) => {
      const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
      return hit !== null && element.contains(hit)
    })
  })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`taking over a loaded page keeps the handback and privacy note in view at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/browser-outcome-harness.html?takeover=live")
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill("Rascunho que deve continuar aqui")
    const takeover = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeEnabled({ timeout: 20_000 })
    await takeover.click()

    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    // Wait for the worker renderer so a transient fallback image cannot hide a missing canvas role.
    await expect(view.locator("canvas")).toBeVisible({ timeout: 20_000 })
    const handback = view.getByRole("button", { name: "Devolver para mark", exact: true })
    const privacy = view.getByRole("status", { name: "Privacidade do navegador" })
    await page.evaluate(() => document.fonts.ready)
    await nextFrames(page)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-live-${viewport.width}.png`,
        mask: [page.locator(".composer-model")],
        maskColor: "#28282b",
      })

    await expect(view.getByRole("img")).toBeVisible({ timeout: 20_000 })

    for (const element of [handback, privacy]) {
      await expect(element).toBeInViewport({ ratio: 1 })
      expect(await isUncovered(element)).toBe(true)
    }

    await handback.click()
    await expect(view).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as Window & { browserOutcome?: { releases: string[] } }).browserOutcome?.releases,
      ),
    ).toEqual(["browser-outcome-tab"])
    await expect(
      page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true }),
    ).toBeVisible()
    await expect(input).toHaveValue("Rascunho que deve continuar aqui")
  })

  test(`a preview settling at the end keeps a pressed takeover in place at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/browser-outcome-harness.html?takeover=live&preview=deferred")
    const takeover = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeEnabled({ timeout: 20_000 })
    await expect(page.locator(".browser-activity-placeholder")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await takeover.scrollIntoViewIfNeeded()
    await nextFrames(page)
    const preview = page.locator(".browser-activity-preview")
    const heightBefore = await preview.evaluate((element) => element.clientHeight)
    const before = await takeover.boundingBox()
    if (!before) throw new Error("Missing takeover control")
    await page.mouse.move(before.x + before.width / 2, before.y + 4)
    await page.mouse.down()

    await page.evaluate(() => {
      const outcome = (window as Window & { browserOutcome?: { showPreview: () => void } }).browserOutcome
      outcome?.showPreview()
    })
    await expect(page.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
    await nextFrames(page)
    const after = await takeover.boundingBox()
    if (!after) throw new Error("Missing pressed takeover control")
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-pressed-${viewport.width}.png` })
    const shift = Math.abs(after.y - before.y)
    const heightAfter = await preview.evaluate((element) => element.clientHeight)
    console.log(
      JSON.stringify({
        width: viewport.width,
        pressedTakeoverShiftPx: shift,
        previewHeightChangePx: heightAfter - heightBefore,
      }),
    )
    await page.mouse.up()

    expect(heightAfter).toBe(heightBefore)
    expect(shift).toBeLessThanOrEqual(1)
    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(view.getByRole("button", { name: "Devolver para mark", exact: true })).toBeVisible()
    await nextFrames(page)
    const measurements = await page.evaluate(() => {
      const outcome = (
        window as Window & {
          browserOutcome?: { takeoverMeasurements: Map<number, { renderMs: number; longTasks: number[]; cls: number }> }
        }
      ).browserOutcome
      return Array.from(outcome?.takeoverMeasurements.values() ?? [])
    })
    expect(measurements).toHaveLength(1)
    expect(measurements.every((measurement) => measurement.cls === 0)).toBe(true)
    console.log(JSON.stringify({ width: viewport.width, takeoverMeasurements: measurements }))
  })

  test(`a preview settling near the latest messages keeps takeover clickable at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/browser-outcome-harness.html?takeover=live&preview=deferred")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible({
      timeout: 20_000,
    })
    const takeover = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeEnabled({ timeout: 20_000 })
    const history = page.locator(".message-scroll")
    await expect(page.locator(".browser-activity-placeholder")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await history.evaluate((list) => list.scrollTo(0, list.scrollHeight - list.clientHeight - 54))
    await expect(page.locator(".chat-scroll-bottom")).toBeVisible()
    await history.evaluate((list) => list.scrollTo(0, list.scrollHeight - list.clientHeight - 54))
    await nextFrames(page)
    const historyBounds = await history.boundingBox()
    const jumpBounds = await page.locator(".chat-scroll-bottom").boundingBox()
    if (!historyBounds || !jumpBounds) throw new Error("Missing history navigation")
    expect(historyBounds.y + historyBounds.height).toBeLessThanOrEqual(jumpBounds.y)
    const point = await takeover.boundingBox()
    if (!point) throw new Error("Missing takeover control")
    await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2)
    await page.mouse.down()
    await nextFrames(page)
    const before = await takeover.boundingBox()
    const heightBefore = await history.evaluate((list) => list.clientHeight)
    if (!before) throw new Error("Missing pressed takeover control")

    await page.evaluate(() => {
      const outcome = (window as Window & { browserOutcome?: { showPreview: () => void } }).browserOutcome
      outcome?.showPreview()
    })
    await expect(page.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
    await nextFrames(page)
    const after = await takeover.boundingBox()
    const heightAfter = await history.evaluate((list) => list.clientHeight)
    if (!after) throw new Error("Missing takeover control after preview")
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-preview-${viewport.width}.png`,
        mask: [page.locator(".composer-model")],
        maskColor: "#28282b",
      })
    await page.mouse.up()

    console.log(
      JSON.stringify({
        width: viewport.width,
        takeoverShiftPx: Math.abs(after.y - before.y),
        historyHeightChangePx: heightAfter - heightBefore,
      }),
    )
    expect(heightAfter).toBe(heightBefore)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(view.getByRole("button", { name: "Devolver para mark", exact: true })).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          (window as Window & { browserOutcome?: { takeoverRequests: Set<number> } }).browserOutcome?.takeoverRequests
            .size,
      ),
    ).toBe(1)
  })
}

const nextFrames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
