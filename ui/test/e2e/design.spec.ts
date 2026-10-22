import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { showBotChat, showBotRoutines } from "./home-navigation"

const capture = process.env.DESIGN_CAPTURE
test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })

test("design: stable workspace captures", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-13T15:00:00Z") })
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  for (const theme of capture === "before" ? ["dark"] : ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await showBotChat(page)
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (capture) await page.screenshot({ path: `../docs/qa/design/${capture}-chat-${theme}.png` })
    await showBotRoutines(page)
    await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeVisible()
    if (capture) await page.screenshot({ path: `../docs/qa/design/${capture}-cron-${theme}.png` })
    await showBotChat(page)
    if (!(await page.getByRole("button", { name: "Preview do projeto" }).isVisible()))
      await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await page.getByRole("button", { name: "Preview do projeto" }).click()
    await expect(page.getByRole("button", { name: "Voltar ao chat" })).toBeVisible()
    if (capture) await page.screenshot({ path: `../docs/qa/design/${capture}-preview-${theme}.png` })
    await page.getByRole("button", { name: "Voltar ao chat" }).click()
  }
})

for (const theme of ["dark", "light"]) {
  test(`design: ${theme} workspace screens stay accessible`, async ({ page }) => {
    test.skip(capture === "before")
    test.setTimeout(60_000)
    await page.goto("/")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    for (const screen of ["chat", "cron", "preview"]) {
      if (screen === "cron") await showBotRoutines(page)
      if (screen === "preview") {
        await showBotChat(page)
        if (!(await page.getByRole("button", { name: "Preview do projeto" }).isVisible()))
          await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
        await page.getByRole("button", { name: "Preview do projeto" }).click()
      }
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([])
    }
  })
}

test("design: theme choice is saved through settings and survives reload", async ({ page }) => {
  test.skip(capture === "before")
  await page.goto("/")
  await page.getByRole("button", { name: "Você Local · grátis", exact: true }).click()
  await page.getByLabel("Tema", { exact: true }).selectOption("light")
  await page.getByRole("button", { name: "Salvar preferências" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
})

test("design: one reveal write drives composer and disclosure effects", async ({ page }) => {
  test.skip(capture === "before")
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/design-harness.html")
  const composer = page.locator(".composer")
  const effects = await composer.evaluate((element) => {
    const node = element as HTMLElement
    node.style.setProperty("--reveal", "0")
    getComputedStyle(node).opacity
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "1")
    getComputedStyle(node).opacity
    const animation = node.getAnimations()[0]
    if (!animation) throw new Error("Reveal transition did not start")
    animation.pause()
    animation.currentTime = 70
    const computed = getComputedStyle(node)
    return {
      reveal: Number(computed.getPropertyValue("--reveal")),
      opacity: Number(computed.opacity),
      transform: computed.transform,
    }
  })
  expect(effects.reveal).toBeGreaterThan(0)
  expect(effects.reveal).toBeLessThan(1)
  expect(effects.opacity).toBeCloseTo(effects.reveal, 4)
  expect(effects.transform).not.toBe("none")
  const summary = page.getByRole("button", { name: "1 chamada de ferramenta" })
  await summary.click()
  await expect(summary).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(".disclosure-reveal")).not.toHaveAttribute("inert")
  await expect(page.getByRole("button", { name: "Expandir resultado" })).toBeVisible()
  const disclosure = page.locator(".disclosure-reveal")
  const cardEffects = await disclosure.evaluate((element) => {
    // Short reveals may finish before Playwright's visibility checks under shared CPU load.
    const node = element as HTMLElement
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "0")
    getComputedStyle(node).height
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "1")
    getComputedStyle(node).height
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error("Card reveal transition did not start")
    animation.pause()
    animation.currentTime = 120
    const computed = getComputedStyle(element)
    return {
      reveal: Number(computed.getPropertyValue("--reveal")),
      opacity: Number(computed.opacity),
      height: Number.parseFloat(computed.height),
      contentHeight: Number.parseFloat(computed.getPropertyValue("--disclosure-size")),
    }
  })
  expect(cardEffects.reveal).toBeGreaterThan(0)
  expect(cardEffects.reveal).toBeLessThan(1)
  expect(cardEffects.opacity).toBeCloseTo(cardEffects.reveal, 4)
  expect(cardEffects.height).toBeCloseTo(cardEffects.contentHeight * cardEffects.reveal, 1)
  await summary.press("Enter")
  await expect(page.locator(".disclosure-reveal")).toHaveAttribute("inert")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test("design: push/pop reverses along the inline direction in the WebKit fallback", async ({ page }) => {
  test.skip(capture === "before")
  await page.addInitScript(() => {
    Object.defineProperty(document, "startViewTransition", { value: undefined })
    const original = HTMLElement.prototype.animate
    HTMLElement.prototype.animate = function (frames, options) {
      const animation = original.call(this, frames, options)
      if (this.classList.contains("workspace-page")) {
        animation.pause()
        animation.currentTime = 1
      }
      return animation
    }
  })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/design-harness.html")
  for (const direction of ["ltr", "rtl"]) {
    await page.evaluate((value) => {
      document.documentElement.dir = value
    }, direction)
    await page.getByRole("button", { name: "Abrir preview", exact: true }).click()
    const outgoing = page.locator(".workspace-page")
    await expect(outgoing).toHaveAttribute("data-navigation", "push")
    const push = await outgoing.evaluate((element) => {
      const animation = element.getAnimations()[0]
      if (!animation) throw new Error("Page animation did not start")
      animation.pause()
      animation.currentTime = 1
      return new DOMMatrix(getComputedStyle(element).transform).m41
    })
    expect(Math.sign(push)).toBe(direction === "ltr" ? 1 : -1)
    await page.getByRole("button", { name: "Voltar ao chat", exact: true }).click()
    await expect(outgoing).toHaveAttribute("data-navigation", "pop")
    const pop = await outgoing.evaluate((element) => {
      const animation = element.getAnimations()[0]
      if (!animation) throw new Error("Page animation did not start")
      animation.pause()
      animation.currentTime = 1
      return new DOMMatrix(getComputedStyle(element).transform).m41
    })
    expect(Math.sign(pop)).toBe(direction === "ltr" ? -1 : 1)
  }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.getByRole("button", { name: "Abrir preview", exact: true }).click()
  expect(await page.locator(".workspace-page").evaluate((element) => element.getAnimations().length)).toBe(0)
})

test("design: native page snapshots animate both sides with the generated easing", async ({ page }) => {
  test.skip(capture === "before")
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/design-harness.html")
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = (update) => {
      const transition = start(update)
      void transition.ready
        .then(() => {
          for (const animation of document.getAnimations()) {
            if ((animation as CSSAnimation).animationName?.startsWith("page-push-pop-")) animation.pause()
          }
        })
        .catch(() => undefined)
      return transition
    }
  })
  await page.getByRole("button", { name: "Abrir preview", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Preview", exact: true })).toBeVisible()
  // The heading commits before the native snapshots and their animations are ready.
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().map((animation) => (animation as CSSAnimation).animationName)),
    )
    .toEqual(expect.arrayContaining(["page-push-pop-in", "page-push-pop-out"]))
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
})
