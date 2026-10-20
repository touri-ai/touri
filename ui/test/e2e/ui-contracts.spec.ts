import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" })
const url = "/test/e2e/ui-contracts-harness.html"

for (const theme of ["light", "dark"]) {
  test(`B11: ${theme} menu, composer, modal, bubble and focus evidence`, async ({ page }, info) => {
    await page.goto(url)
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await page.evaluate(() => document.fonts.ready)
    for (const selector of [".bot-context-menu", ".composer", ".modal-card", ".message-user"]) {
      const surface = page.locator(selector).first()
      await expect(surface).toBeVisible()
      expect(await surface.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await page.getByRole("menuitem", { name: "Abrir conversa" }).focus()
    await expect(page.getByRole("menuitem", { name: "Abrir conversa" })).toHaveCSS("outline-style", "solid")
    expect(
      await page
        .locator(".modal-card")
        .evaluate((node) => getComputedStyle(node).boxShadow.split(/, (?![^()]*\))/).length),
    ).toBe(2)
    await page.screenshot({
      path: info.outputPath(`surfaces-${theme}.png`),
      fullPage: true,
      mask: [page.locator("[data-approval-id] .tool-summary")],
    })
  })
}

for (const coarse of [false, true]) {
  test(`S08: ${coarse ? "coarse" : "fine"} pointer target sizes`, async ({ browser, baseURL }, info) => {
    const context = await browser.newContext({
      hasTouch: coarse,
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    await page.goto(`${baseURL}${url}`)
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse)
    const icon = page.locator(".sidebar-icon-button")
    await expect(icon).toHaveCSS("height", coarse ? "44px" : "40px")
    const tab = page.locator(".bot-panel-tabs button")
    expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(coarse ? 44 : 32)
    for (const selector of [".bot-context-menu button", ".tool-action", ".tool-details > summary"]) {
      for (const box of await page.locator(selector).evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })),
      )) {
        if (coarse) {
          expect(box.height).toBeGreaterThanOrEqual(44)
          expect(box.width).toBeGreaterThanOrEqual(44)
        }
      }
    }
    await page.screenshot({
      path: info.outputPath(`pointer-${coarse ? "coarse" : "fine"}.png`),
      fullPage: true,
      mask: [page.locator("[data-approval-id] .tool-summary")],
    })
    await context.close()
  })
}

test("S08: forced colors preserve focus, status text and deliberate keyboard approval", async ({ page }, info) => {
  await page.emulateMedia({ forcedColors: "active" })
  await page.goto(url)
  const card = page.locator("[data-approval-id=visual-approval]")
  await card.focus()
  await expect(card).toHaveCSS("outline-style", "solid")
  await expect(card).toHaveCSS("border-top-style", "dashed")
  await card.press("Enter")
  await expect(card.locator(".tool-status-chip")).toContainText("Aguardando aprovação")
  await expect(card.locator(".tool-decision-chip")).toHaveCount(0)
  await expect(page.locator(".tool-status-chip").first()).toContainText("Concluído")
  await page.screenshot({
    path: info.outputPath("forced-colors-focus-status.png"),
    fullPage: true,
    mask: [page.locator("[data-approval-id] .tool-summary")],
  })
})

test("A13b: state ink interpolates and reduced motion retains its static destination", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(url)
  const mark = page.locator(".activity-mark")
  const initial = await mark.evaluate((node) => getComputedStyle(node).color)
  await page.getByRole("button", { name: "Usar ferramenta", exact: true }).click()
  const mid = await mark.evaluate((node) => {
    const animation = node
      .getAnimations()
      .find((item) => (item as CSSTransition).transitionProperty === "--activity-ink")
    if (!animation) throw new Error("Activity ink did not transition")
    animation.pause()
    animation.currentTime = 120
    return getComputedStyle(node).color
  })
  expect(mid).not.toBe(initial)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect.poll(() => mark.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
  await page.getByRole("button", { name: "Aguardar aprovação", exact: true }).click()
  await expect(mark).toContainText("Preciso da sua autorização.")
  await expect(mark).toHaveCSS("transition-duration", "0s")
})

test("A14: tool deltas keep insertion stable and disclosures preserve the reading anchor", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(url)
  const card = page.locator(".tool-call-card").first()
  await expect(card).toHaveClass(/tool-surface-reveal/)
  const effects = await card.evaluate((element) => {
    const node = element as HTMLElement
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "0")
    getComputedStyle(node).opacity
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "1")
    getComputedStyle(node).opacity
    const animation = node.getAnimations()[0]
    if (!animation) throw new Error("Tool insertion did not reveal")
    animation.pause()
    animation.currentTime = 70
    const style = getComputedStyle(node)
    const result = {
      reveal: Number(style.getPropertyValue("--reveal")),
      opacity: Number(style.opacity),
      transform: style.transform,
    }
    animation.finish()
    return result
  })
  expect(effects.reveal).toBeGreaterThan(0)
  expect(effects.reveal).toBeLessThan(1)
  expect(effects.opacity).toBeCloseTo(effects.reveal, 4)
  expect(effects.transform).not.toBe("none")
  await card.locator(".tool-output > summary").press("Enter")
  await expect(card.locator(".disclosure-reveal").first()).toHaveCSS("opacity", "1")
  await expect(card.locator(".tool-output .tool-code-region")).toBeVisible()
  await expect
    .poll(() =>
      card
        .locator(".disclosure-reveal")
        .first()
        .evaluate((node) => node.getBoundingClientRect().height),
    )
    .toBeGreaterThan(0)
  await page.getByRole("button", { name: "Mais texto" }).click()
  await expect(card.locator(".tool-output")).toContainText("Texto novo.")
  expect(await card.evaluate((node) => node.getAnimations().length)).toBe(0)
  await page.emulateMedia({ reducedMotion: "reduce" })
  const list = page.getByTestId("virtual-message-list")
  await list.locator(".turn-activity-toggle").last().press("Enter")
  const summary = list.locator(".tool-output > summary").last()
  await summary.scrollIntoViewIfNeeded()
  const before = await summary.evaluate((node) => node.getBoundingClientRect().top)
  await summary.press("Enter")
  await expect(summary.locator("..")).toHaveAttribute("open", "")
  await expect.poll(() => summary.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(before, 0)
  await summary.press("Space")
  await expect(summary.locator("..")).not.toHaveAttribute("open")
})

test("A15: destination focus follows RTL push/pop with and without motion", async ({ page }) => {
  await page.goto("/test/e2e/design-harness.html")
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion })
    await page.evaluate(() => {
      document.documentElement.dir = "rtl"
    })
    await page.getByRole("button", { name: "Abrir preview", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Preview", exact: true })).toBeFocused()
    await expect(page.locator(".workspace-page")).toHaveAttribute("data-navigation", "push")
    await page.getByRole("button", { name: "Voltar ao chat", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Conversa", exact: true })).toBeFocused()
    await expect(page.locator(".workspace-page")).toHaveAttribute("data-navigation", "pop")
  }
})
