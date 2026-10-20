import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const phase = process.env.CHAT_IMAGE_PHASE ?? "after"
const capture = process.env.CHAT_IMAGE_CAPTURE === "1"
test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const theme of ["dark", "light"]) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    test(`${phase} chat image layout · ${viewport.name} · ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`/test/e2e/chat-image-harness.html?theme=${theme}`)
      await expect(page.locator('[data-message-id="image-reply"]')).toBeAttached()
      const list = page.locator("[data-testid='virtual-message-list']")
      const gallery = page.getByRole("region", { name: "Imagens de evidência" })
      await expect(gallery).toBeAttached()
      await gallery.scrollIntoViewIfNeeded()
      const thumbnails = page.locator(".evidence-gallery img")
      await expect(thumbnails).toHaveCount(2, { timeout: 15_000 })
      await expect(thumbnails.nth(0)).toBeVisible()
      await expect(thumbnails.nth(1)).toBeVisible()
      await expect
        .poll(() =>
          thumbnails.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0)),
        )
        .toBe(true)
      if (phase === "after") await list.evaluate((element) => (element.scrollTop = element.scrollHeight))
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
      await page.evaluate(() => document.fonts.ready)
      if (capture)
        await page.screenshot({
          path: testInfo.outputPath(`${phase}-${viewport.name}-${theme}.png`),
          animations: "disabled",
        })
      if (phase === "before") return

      const cards = page.locator(".evidence-gallery figure")
      await expect(cards).toHaveCount(2)
      await expect(cards.nth(0).locator("figcaption")).toHaveText("mobile")
      await expect(cards.nth(1).locator("figcaption")).toHaveText("desktop")
      await expect(cards.nth(0).getByRole("button", { name: "Baixar imagem" })).toBeVisible()
      await expect(cards.nth(1).getByRole("button", { name: "Baixar imagem" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Voltar ao fim" })).toHaveCount(0)

      const metrics = await page.locator("[data-testid='virtual-message-list']").evaluate((list) => {
        const scroller = list as HTMLElement
        const last = scroller.querySelector<HTMLElement>('[data-message-row="image-reply"]')
        if (!last) return null
        const listBounds = scroller.getBoundingClientRect()
        const rowBounds = last.getBoundingClientRect()
        return {
          bottomGap: listBounds.bottom - rowBounds.bottom,
          remainingScroll: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
        }
      })
      expect(metrics).not.toBeNull()
      expect(metrics?.bottomGap).toBeLessThan(120)
      expect(metrics?.remainingScroll).toBeLessThan(2)

      const previews = await page.locator(".evidence-thumbnail img").evaluateAll((images) =>
        images.map((image) => ({
          width: (image as HTMLImageElement).naturalWidth,
          height: (image as HTMLImageElement).naturalHeight,
          filter: getComputedStyle(image).filter,
        })),
      )
      expect(previews).toHaveLength(2)
      expect(previews.every((image) => image.width > 0 && image.height > 0 && image.filter === "none")).toBe(true)
      expect(previews[0]?.height ?? 0).toBeGreaterThan(600)
      expect(previews[1]?.width ?? 0).toBeGreaterThan(900)

      const accessibility = await new AxeBuilder({ page })
        .include(".evidence-gallery")
        .withRules(["color-contrast", "button-name", "image-alt"])
        .analyze()
      expect(accessibility.violations).toEqual([])

      const openImage = cards.nth(0).getByRole("button", { name: /Abrir captura 1/ })
      await openImage.focus()
      await page.keyboard.press("Enter")
      const lightbox = page.getByRole("dialog")
      await expect(lightbox).toBeVisible()
      await expect(lightbox.locator("img")).toHaveAttribute("alt", "mobile")
      const originalSize = await lightbox.locator("img").evaluate((image) => ({
        width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight,
      }))
      expect(originalSize).toEqual({ width: 1170, height: 2532 })
      await lightbox.getByRole("button", { name: "Fechar imagem" }).click()
    })
  }
}

test("remeasures mounted transcript rows when streamed content grows and collapses", async ({ page }) => {
  test.skip(phase === "before", "Baseline has no variable row measurements")
  await page.goto("/test/e2e/chat-image-harness.html?theme=dark")
  const gallery = page.getByRole("region", { name: "Imagens de evidência" })
  await expect(gallery.locator("img")).toHaveCount(2)
  await gallery.scrollIntoViewIfNeeded()
  const list = page.getByTestId("virtual-message-list")
  const spacer = list.locator(":scope > div").first()
  await expect.poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(0)
  await expect.poll(() => list.locator("[data-message-row]").count()).toBeLessThan(60)
  await page.waitForTimeout(200)
  const originalHeight = await spacer.evaluate((element) => element.getBoundingClientRect().height)

  await page.locator('[data-message-row="image-reply"]').evaluate((row) => {
    const content = document.createElement("div")
    content.dataset.testGrowth = "true"
    content.style.height = "500px"
    row.append(content)
  })

  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(originalHeight + 500, 0)

  await page.locator("[data-test-growth]").evaluate((element) => element.remove())

  await expect
    .poll(() => spacer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(originalHeight, 0)
})
