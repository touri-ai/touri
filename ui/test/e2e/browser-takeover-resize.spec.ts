import { expect, type Locator, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

// Inside the conversation's own visible area (and above the keyboard) and on top: not clipped, not covered.
const getPlacement = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const list = document.querySelector(".message-scroll")?.getBoundingClientRect()
    const visibleBottom = window.visualViewport
      ? window.visualViewport.offsetTop + window.visualViewport.height
      : Infinity
    const visibleTop = Math.max(list?.top ?? 0, window.visualViewport?.offsetTop ?? 0)
    return {
      withinHistory: list ? box.top >= visibleTop - 1 && box.bottom <= Math.min(list.bottom, visibleBottom) + 1 : false,
      hittable: [box.top + 1, box.bottom - 1].every((y) => {
        const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
        return hit !== null && element.contains(hit)
      }),
    }
  })

const reachable = { withinHistory: true, hittable: true }

const captureControls = async (page: Page, name: string) => {
  const directory = process.env.TOURI_TAKEOVER_RESIZE_CAPTURE_DIR
  if (!directory) return

  await page.screenshot({
    path: `${directory}/${name}.png`,
    mask: [page.locator(".composer-model")],
    maskColor: "#28282b",
  })
}

const nextFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let left = 4
        const tick = () => (--left ? requestAnimationFrame(tick) : resolve())
        requestAnimationFrame(tick)
      }),
  )

const takeOver = async (page: Page, size: { width: number; height: number }, long: boolean) => {
  await page.setViewportSize(size)
  await page.goto(`/test/e2e/browser-outcome-harness.html?takeover=live${long ? "&long=1" : ""}`)
  const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
  await expect(input).toBeVisible({ timeout: 20_000 })
  await input.fill("Rascunho que deve continuar aqui")
  const takeOverButton = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
  await expect(takeOverButton).toBeEnabled({ timeout: 20_000 })
  await takeOverButton.dispatchEvent("click")
  const view = page.getByRole("region", { name: "Controle remoto do navegador" })
  await expect(view.getByRole("img")).toBeVisible({ timeout: 20_000 })
  const handback = view.getByRole("button", { name: "Devolver para mark", exact: true })
  await expect.poll(() => getPlacement(handback)).toEqual(reachable)
  return { input, view, handback }
}

const handBack = async (page: Page, input: Locator, view: Locator, handback: Locator) => {
  await handback.dispatchEvent("click")
  await expect(view).toHaveCount(0)
  expect(
    await page.evaluate(
      () => (window as Window & { browserOutcome?: { releases: string[] } }).browserOutcome?.releases,
    ),
  ).toEqual(["browser-outcome-tab"])
  await expect(input).toHaveValue("Rascunho que deve continuar aqui")
}

for (const history of ["short", "long"] as const)
  test(`active take-over keeps its handback reachable after resizing to a phone (${history} conversation)`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const { input, view, handback } = await takeOver(page, { width: 1440, height: 900 }, history === "long")
    await captureControls(page, `takeover-${history}-1440`)

    // The same session moves to a phone-sized window; nothing in the test scrolls the history.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => getPlacement(handback)).toEqual(reachable)
    await expect
      .poll(() => getPlacement(view.getByRole("status", { name: "Privacidade do navegador" })))
      .toEqual(reachable)
    await captureControls(page, `takeover-resized-${history}-390`)

    // Focusing the keyboard entry on the phone must not hide the handback either.
    await view.getByRole("button", { name: "Digitar no navegador" }).dispatchEvent("click")
    await nextFrames(page)
    expect(await getPlacement(handback)).toEqual(reachable)

    await handBack(page, input, view, handback)
  })

test("an on-screen keyboard covering the visible handback brings it back above the keyboard", async ({ page }) => {
  test.setTimeout(60_000)
  const { input, view, handback } = await takeOver(page, { width: 390, height: 844 }, true)
  const history = page.locator(".message-scroll")

  // The person reads a little higher up; the handback stays visible, lower in the history. The history is
  // scrolled directly because a wheel over the live frame goes to the remote page.
  await history.evaluate((list) => list.scrollBy(0, -300))
  await expect.poll(async () => (await handback.boundingBox())?.y ?? 0).toBeGreaterThan(300)
  expect(await getPlacement(handback)).toEqual(reachable)

  // The keyboard opens: only the visual viewport shrinks, up to just above the handback.
  const top = (await handback.boundingBox())?.y ?? 0
  await page.evaluate((height) => {
    const visible = window.visualViewport
    if (!visible) throw new Error("no visual viewport")
    Object.defineProperty(visible, "height", { configurable: true, get: () => height })
    visible.dispatchEvent(new Event("resize"))
  }, Math.floor(top) - 1)
  await expect.poll(() => getPlacement(handback)).toEqual(reachable)

  await handBack(page, input, view, handback)
})

test("resizing does not pull back a person who scrolled away from the take-over", async ({ page }) => {
  test.setTimeout(60_000)
  // A short conversation keeps every row mounted, so the take-over stays rendered while out of view.
  const { input, view, handback } = await takeOver(page, { width: 1440, height: 900 }, false)
  const history = page.locator(".message-scroll")

  await history.evaluate((list) => list.scrollTo(0, 0))
  await expect.poll(async () => (await getPlacement(handback)).withinHistory).toBe(false)

  await page.setViewportSize({ width: 390, height: 844 })
  await nextFrames(page)
  expect((await getPlacement(handback)).withinHistory).toBe(false)

  await handBack(page, input, view, handback)
})

test("a panned visual viewport keeps the handback and privacy note visible", async ({ page }) => {
  const { input, view, handback } = await takeOver(page, { width: 390, height: 844 }, true)

  await page.evaluate(() => {
    const viewport = window.visualViewport
    if (!viewport) throw new Error("Missing visual viewport")
    Object.defineProperties(viewport, {
      offsetTop: { configurable: true, value: 200 },
      height: { configurable: true, value: 400 },
    })
    viewport.dispatchEvent(new Event("resize"))
  })

  await expect.poll(() => getPlacement(handback)).toEqual(reachable)
  await expect
    .poll(() => getPlacement(view.getByRole("status", { name: "Privacidade do navegador" })))
    .toEqual(reachable)
  await handBack(page, input, view, handback)
})
