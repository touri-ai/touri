import { expect, type Locator, test } from "@playwright/test"
import { showBotRoutines } from "./home-navigation"

const capture = process.env.MOTION_CAPTURE
test.use({ channel: "chromium", viewport: { width: 1440, height: 900 } })

// Seek the real CSS transition synchronously so shared CPU load cannot skip the sampled frame.
const probeReveal = (locator: Locator) =>
  locator.evaluate((element) => {
    const node = element as HTMLElement
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "0")
    getComputedStyle(node).getPropertyValue("--reveal")
    for (const animation of node.getAnimations()) animation.finish()
    node.style.setProperty("--reveal", "1")
    getComputedStyle(node).getPropertyValue("--reveal")
    const animation = node.getAnimations()[0]
    if (!animation) throw new Error("Reveal transition did not start")
    animation.pause()
    animation.currentTime = 30
    const ink = node.querySelector(".modal-backdrop, .bot-panel, .notification-popover, .notice-bar") ?? node
    const moving = node.querySelector(".modal-card, .bot-panel, .notification-popover, .notice-bar") ?? node
    const style = getComputedStyle(node)
    const transform = new DOMMatrix(getComputedStyle(moving).transform)
    return {
      duration: animation.effect?.getComputedTiming().duration,
      reveal: Number(style.getPropertyValue("--reveal")),
      opacity: Number(getComputedStyle(ink).opacity),
      scale: transform.a,
      x: transform.m41,
      height: Number.parseFloat(style.height),
      contentHeight: Number.parseFloat(style.getPropertyValue("--disclosure-size")),
    }
  })

if (capture) {
  for (const width of [1440, 1100]) {
    for (const theme of ["dark", "light"]) {
      test(`motion: ${capture} ${theme} ${width}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
        await page.goto("/test/e2e/motion-app.html")
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value
        }, theme)
        await page.evaluate(() => document.fonts.ready)
        const screenshot = async (view: string) => {
          await page.screenshot({
            path: `../docs/qa/r8/motion/${capture}-${view}${width === 1100 ? "-narrow" : ""}-${theme}.png`,
          })
        }
        const panelToggle = page.getByRole("button", { name: "Painel do bot", exact: true })
        if ((await panelToggle.getAttribute("aria-expanded")) === "false") await panelToggle.click()
        await expect(page.getByRole("complementary", { name: "Painel de mark" })).toBeVisible()
        await screenshot("panel")
        await page.getByRole("button", { name: "Fechar painel do bot" }).click()
        await expect(page.locator(".bot-panel")).toHaveCount(0)
        await screenshot("panel-closed")
        await page.getByRole("button", { name: /Você Local/ }).click()
        await expect(page.getByRole("dialog", { name: "Configurações" })).toBeVisible()
        await screenshot("modal")
        await page.getByRole("button", { name: "Fechar diálogo" }).click()
        await page.getByRole("button", { name: /notificaç/i }).click()
        await expect(page.getByRole("region", { name: "Central de notificações" })).toBeVisible()
        await screenshot("notifications")
        await page.keyboard.press("Escape")
        await showBotRoutines(page)
        await expect(page.getByRole("heading", { name: "Rotinas", exact: true })).toBeVisible()
        await screenshot("page")
      })
    }
  }
}

test.describe("motion behavior", () => {
  test.skip(capture === "before")
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("/test/e2e/motion-app.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  })

  test("modal scales and fades, then removes inert content after a short exit", async ({ page }) => {
    await page.getByRole("button", { name: /Você Local/ }).click()
    const enter = await probeReveal(page.locator('.motion-modal[data-motion-state="open"]'))
    expect(enter.duration).toBe(200)
    expect(enter.opacity).toBeGreaterThan(0)
    expect(enter.opacity).toBeLessThan(1)
    expect(enter.scale).toBeGreaterThan(0.98)
    expect(enter.scale).toBeLessThan(1)
    const exit = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const surface = document.querySelector<HTMLElement>('.motion-modal[data-motion-state="open"]')
          if (!surface) throw new Error("Missing modal")
          for (const animation of surface.getAnimations()) animation.finish()
          const observer = new MutationObserver(() => {
            if (surface.dataset.motionState !== "closed") return
            observer.disconnect()
            resolve({
              inert: surface.inert,
              state: surface.dataset.motionState,
              hidden: surface.getAttribute("aria-hidden"),
            })
          })
          observer.observe(surface, { attributes: true })
          surface.querySelector<HTMLButtonElement>(".modal-close")?.click()
        }),
    )
    expect(exit).toEqual({ inert: true, state: "closed", hidden: "true" })
    await expect(page.locator(".modal-card")).toHaveCount(0)
  })

  test("right panel slides in and collapses its track on close without overflow", async ({ page }) => {
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await page.getByRole("button", { name: "Fechar painel do bot" }).click()
    await expect(page.locator(".bot-panel")).toHaveCount(0)
    expect(
      await page.locator(".bot-workspace").evaluate((element) => getComputedStyle(element).gridTemplateColumns),
    ).toMatch(/ 0px$/)
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await expect(page.locator(".bot-panel")).toBeVisible()
    const enter = await probeReveal(page.locator(".motion-panel"))
    expect(enter?.opacity).toBeGreaterThan(0)
    expect(enter?.opacity).toBeLessThan(1)
    expect(enter?.x).toBeGreaterThan(0)
    await page.evaluate(() => {
      document
        .querySelector(".motion-panel")
        ?.getAnimations()
        .forEach((animation) => {
          animation.finish()
        })
    })
    await expect(page.locator(".bot-panel")).toBeVisible()
    expect(await page.locator(".bot-workspace").evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(
      0,
    )
  })

  test("segmented indicator follows selected tabs and keyboard navigation", async ({ page }) => {
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await page.getByRole("tab", { name: "Biblioteca", exact: true }).click()
    const indicator = await page.locator(".bot-panel-tabs").evaluate((element) => {
      const tabs = element as HTMLElement
      const active = tabs.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!active) throw new Error("Missing selected tab")
      const target = active.offsetLeft
      const measured = tabs.style.getPropertyValue("--segment-x")
      for (const animation of tabs.getAnimations({ subtree: true })) animation.finish()
      tabs.style.setProperty("--segment-x", "0px")
      getComputedStyle(tabs, "::before").transform
      for (const animation of tabs.getAnimations({ subtree: true })) animation.finish()
      tabs.style.setProperty("--segment-x", `${target}px`)
      getComputedStyle(tabs, "::before").transform
      const transition = tabs
        .getAnimations({ subtree: true })
        .find((animation) => (animation as CSSTransition).transitionProperty === "transform")
      if (!transition) throw new Error("Indicator transition did not start")
      transition.pause()
      transition.currentTime = 30
      return {
        x: new DOMMatrix(getComputedStyle(tabs, "::before").transform).m41,
        target,
        measured,
        duration: transition.effect?.getComputedTiming().duration,
      }
    })
    expect(indicator.measured).toBe(`${indicator.target}px`)
    expect(indicator?.duration).toBe(200)
    expect(indicator?.x).toBeGreaterThan(0)
    expect(indicator?.x).toBeLessThan(indicator?.target ?? 0)
    await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .forEach((animation) => {
          animation.finish()
        }),
    )
    await page.getByRole("tab", { name: "Biblioteca", exact: true }).press("ArrowRight")
    await expect(page.getByRole("tab", { name: "Computador", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("tab", { name: "Computador", exact: true })).toBeFocused()
  })

  test("notification popover enters and closes through the same presence utility", async ({ page }) => {
    await page.getByRole("button", { name: /notificaç/i }).click()
    await expect(page.locator(".notification-popover")).toBeVisible()
    const enter = await probeReveal(page.locator(".motion-popover"))
    expect(enter.opacity).toBeGreaterThan(0)
    expect(enter.opacity).toBeLessThan(1)
    await page.keyboard.press("Escape")
    await expect(page.locator(".notification-popover")).toHaveCount(0)
  })

  test("disclosures share one reveal, resize when expanded, and keep hidden controls inert", async ({ page }) => {
    await page.goto("/test/e2e/motion-harness.html")
    await page.getByRole("button", { name: "Contexto da conversa" }).click()
    const effects = await probeReveal(page.locator(".disclosure-reveal").first())
    expect(effects?.reveal).toBeGreaterThan(0)
    expect(effects?.reveal).toBeLessThan(1)
    expect(effects?.opacity).toBeCloseTo(effects?.reveal ?? 0, 4)
    expect(effects?.height).toBeCloseTo((effects?.contentHeight ?? 0) * (effects?.reveal ?? 0), 1)
    await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .forEach((animation) => {
          animation.finish()
        }),
    )
    await page.getByRole("button", { name: "Mais anotações" }).click()
    const reveal = page.locator(".disclosure-reveal").first()
    await expect
      .poll(() =>
        reveal.evaluate((element) => Math.abs(element.clientHeight - (element.firstElementChild?.clientHeight ?? 0))),
      )
      .toBeLessThanOrEqual(1)
    await page.getByRole("button", { name: "Contexto da conversa" }).click()
    await expect(reveal).toHaveAttribute("inert")
    await expect(page.getByRole("button", { name: "Mais anotações" })).toHaveCount(0)
  })

  test("notice enters once and can be dismissed during its animation", async ({ page }) => {
    await page.goto("/test/e2e/motion-harness.html")
    await page.getByRole("button", { name: "Mostrar aviso" }).click()
    await expect(page.locator(".notice-bar")).toBeVisible()
    const entry = await probeReveal(page.locator(".motion-toast"))
    expect(entry.opacity).toBeGreaterThan(0)
    expect(entry.opacity).toBeLessThan(1)
    await page.getByRole("button", { name: "Dispensar aviso" }).dispatchEvent("click")
    await expect(page.locator(".notice-bar")).toHaveCount(0)
  })

  for (const preference of ["system", "app"]) {
    test(`${preference} reduced motion stops running surfaces and skeleton shimmer`, async ({ page }) => {
      await page.getByRole("button", { name: /Você Local/ }).click()
      if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" })
      else
        await page.evaluate(() => {
          document.documentElement.dataset.motion = "reduce"
        })
      await expect
        .poll(() => page.locator(".motion-modal").evaluate((element) => element.getAnimations().length))
        .toBe(0)
      await page.getByRole("button", { name: "Fechar diálogo" }).click()
      await expect(page.locator(".modal-card")).toHaveCount(0)
      await page.goto("/test/e2e/motion-harness.html")
      if (preference === "app")
        await page.evaluate(() => {
          document.documentElement.dataset.motion = "reduce"
        })
      await expect
        .poll(() =>
          page
            .locator(".motion-skeleton span")
            .first()
            .evaluate((element) => element.getAnimations().length),
        )
        .toBe(0)
      await page.getByRole("button", { name: "Contexto da conversa" }).click()
      await expect(page.locator(".disclosure-reveal").first()).not.toHaveAttribute("inert")
      expect(
        await page
          .locator(".disclosure-reveal")
          .first()
          .evaluate((element) => element.getAnimations().length),
      ).toBe(0)
    })
  }
})
