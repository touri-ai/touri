import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 } })
const fixture = "/test/e2e/ui-contracts-harness.html"

for (const theme of ["light", "dark"]) {
  test(`${theme}: registered ink interpolates between readable state colors`, async ({ page }) => {
    await page.goto(fixture)
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await expect(page.locator("html")).toHaveAttribute("data-motion-properties", "registered")
    const colors = await page.locator(".activity-mark").evaluate((node) => {
      for (const animation of node.getAnimations()) animation.finish()
      const start = getComputedStyle(node).color
      node.setAttribute("data-mascot-state", "waiting-approval")
      getComputedStyle(node).color
      const animation = node
        .getAnimations()
        .find((item) => (item as CSSTransition).transitionProperty === "--activity-ink")
      if (!animation) throw new Error("Registered ink did not transition")
      animation.pause()
      animation.currentTime = 40
      const middle = getComputedStyle(node).color
      animation.finish()
      return { start, middle, end: getComputedStyle(node).color }
    })
    expect(colors.middle).not.toBe(colors.start)
    expect(colors.middle).not.toBe(colors.end)
    expect(colors.end).not.toBe(colors.start)
  })

  test(`${theme}: one reveal scalar drives composer and tool opacity, translation and scale`, async ({ page }) => {
    await page.goto(fixture)
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    for (const [selector, distance, scaleStart] of [
      [".composer", 8, 0.98],
      [".tool-surface-reveal", 4, 0.995],
    ] as const) {
      const sampled = await page
        .locator(selector)
        .first()
        .evaluate((element) => {
          const node = element as HTMLElement
          for (const animation of node.getAnimations()) animation.finish()
          node.style.setProperty("--reveal", "0")
          getComputedStyle(node).opacity
          for (const animation of node.getAnimations()) animation.finish()
          node.style.setProperty("--reveal", "1")
          getComputedStyle(node).opacity
          const animation = node.getAnimations()[0]
          if (!animation) throw new Error("Scalar reveal did not transition")
          animation.pause()
          animation.currentTime = 40
          const style = getComputedStyle(node)
          const matrix = new DOMMatrix(style.transform)
          const sample = {
            property: (animation as CSSTransition).transitionProperty,
            reveal: Number(style.getPropertyValue("--reveal")),
            opacity: Number(style.opacity),
            y: matrix.m42,
            scale: matrix.a,
          }
          animation.finish()
          return sample
        })
      expect(sampled.property).toBe("--reveal")
      expect(sampled.reveal).toBeGreaterThan(0)
      expect(sampled.reveal).toBeLessThan(1)
      expect(sampled.opacity).toBeCloseTo(sampled.reveal, 4)
      expect(sampled.y).toBeCloseTo((1 - sampled.reveal) * distance, 3)
      expect(sampled.scale).toBeCloseTo(scaleStart + sampled.reveal * (1 - scaleStart), 4)
    }
  })
}

test("webviews without registered properties keep color and surface fallbacks", async ({ page }) => {
  await page.goto(fixture)
  await page.evaluate(() => {
    document.documentElement.dataset.motionProperties = "fallback"
  })
  await expect(page.locator(".activity-mark")).toHaveCSS("transition-property", "color")
  await expect(page.locator(".composer")).toHaveCSS("transition-property", "opacity, transform")
  await expect(page.locator(".tool-surface-reveal").first()).toHaveCSS("transition-property", "opacity, transform")
  await page.getByRole("button", { name: "Aguardar aprovação", exact: true }).click()
  await expect(page.locator(".activity-mark")).toContainText("Preciso da sua autorização.")
  await expect(page.locator(".composer")).toHaveCSS("opacity", "1")
})

test("menus use the generated springs", async ({ page }) => {
  await page.goto(fixture)
  await expect(page.locator(".bot-context-menu")).toHaveCSS("animation-timing-function", /^linear\(/)
})

test("popovers and inserted attachment chips use the generated springs", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("touri motion fixture"),
  })
  await expect(page.locator(".attachment-chip")).toBeVisible()
  await expect(page.locator(".attachment-chip")).toHaveCSS("animation-timing-function", /^linear\(/)
  await page.getByRole("button", { name: /notificaç/i }).click()
  await expect(page.locator(".motion-popover")).toHaveCSS("transition-timing-function", /^linear\(/)
})

for (const preference of ["system", "app"]) {
  test(`${preference}: motion can stop live and all surfaces keep their final readable state`, async ({ page }) => {
    await page.goto(fixture)
    if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" })
    else
      await page.evaluate(() => {
        document.documentElement.dataset.motion = "reduce"
      })
    await page.getByRole("button", { name: "Aguardar aprovação", exact: true }).click()
    await expect(page.locator(".activity-mark")).toHaveAttribute("data-reduced-motion", "true")
    await expect(page.locator(".activity-mark")).toContainText("Preciso da sua autorização.")
    for (const selector of [".activity-mark", ".composer", ".tool-surface-reveal", ".bot-context-menu"]) {
      const surface = page.locator(selector).first()
      await expect(surface).toHaveCSS("transition-duration", "0s")
      await expect(surface).toHaveCSS("opacity", "1")
      expect(await surface.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0)
    }
  })
}
