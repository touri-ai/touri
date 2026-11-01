import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const before = process.env.IMAGE_RECOVERY_PHASE === "before"
test.use({ channel: "chromium", reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  test(`Library image failure at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/image-recovery-harness.html?screen=library&state=denied")
    await page.getByRole("button", { name: /result.png.*KB/ }).click()
    const error = "Imagem fora da pasta do bot"

    await expect(page.getByText(error, { exact: true })).toBeVisible()
    await expect(page.getByText("/workspace/result.png", { exact: true })).toHaveCount(1)
    if (!before) {
      expect((await new AxeBuilder({ page }).include(".evidence-gallery").analyze()).violations).toEqual([])
      if (width === 390) {
        const targets = await page
          .locator(".evidence-image button:enabled")
          .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
        expect(targets.every((height) => height >= 44)).toBe(true)
      }
    }
    const directory = process.env.IMAGE_RECOVERY_EVIDENCE_DIR
    if (directory) await mkdir(directory, { recursive: true })
    const filename = `${before ? "before" : "after"}-library-${width}.png`
    await page.screenshot({ path: directory ? join(directory, filename) : testInfo.outputPath(filename) })
  })
}

const scenarios = [1440, 390].flatMap((width) =>
  ["dark", "light"].flatMap((theme) => ["denied", "persisted"].map((state) => ({ width, theme, state }))),
)
for (const { width, theme, state } of scenarios) {
  test(`image recovery ${state} at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/test/e2e/image-recovery-harness.html?state=${state}&theme=${theme}`)
    if (!before && state === "persisted") {
      await expect(page.getByRole("img", { name: "Arte de exemplo" })).toBeVisible()
      const box = await page.locator(".evidence-thumbnail").boundingBox()
      expect(box && Math.abs(box.width / box.height - 2)).toBeLessThan(0.05)
    } else if (!before) {
      await expect(page.getByText("Imagem fora da pasta do bot", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toHaveCount(0)
      await expect(page.getByText("/outside/result.png", { exact: true })).toBeVisible()
      const box = await page.locator(".evidence-thumbnail").boundingBox()
      expect(box?.height).toBeLessThanOrEqual(121)
      const fontSizes = await page.locator(".evidence-image").evaluate((figure) => ({
        path: Number.parseFloat(getComputedStyle(figure.querySelector(".evidence-path") ?? figure).fontSize),
        caption: Number.parseFloat(getComputedStyle(figure.querySelector("figcaption") ?? figure).fontSize),
      }))
      expect(fontSizes.path).toBeLessThanOrEqual(fontSizes.caption)
      await expect(page.getByRole("button", { name: "Baixar imagem" })).toHaveCount(0)
    } else {
      await expect(page.locator(".evidence-thumbnail")).not.toContainText("Carregando imagem…")
    }
    if (!before) {
      expect((await new AxeBuilder({ page }).include(".evidence-gallery").analyze()).violations).toEqual([])
      if (width === 390) {
        const targets = await page
          .locator(".evidence-image button:enabled")
          .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
        expect(targets.every((height) => height >= 44)).toBe(true)
      }
    }
    const directory = process.env.IMAGE_RECOVERY_EVIDENCE_DIR
    if (directory) await mkdir(directory, { recursive: true })
    const getCapturePath = (name: string) => (directory ? join(directory, name) : testInfo.outputPath(name))
    await page.screenshot({ path: getCapturePath(`${before ? "before" : "after"}-${theme}-${state}-${width}.png`) })
    await page.getByRole("button", { name: /Abrir captura/ }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    if (!before && state === "denied") {
      await expect(dialog.getByText("Imagem fora da pasta do bot", { exact: true })).toBeVisible()
      await expect(dialog.getByRole("navigation")).toHaveCount(0)
      const box = await dialog.boundingBox()
      expect(box?.height).toBeLessThan(360)
      expect(box && Math.abs(box.y + box.height / 2 - 450)).toBeLessThan(2)
    } else if (!before) await expect(dialog.getByRole("img")).toBeVisible()
    if (!before) expect((await new AxeBuilder({ page }).include(".evidence-lightbox").analyze()).violations).toEqual([])
    await page.screenshot({
      path: getCapturePath(`${before ? "before" : "after"}-${theme}-viewer-${state}-${width}.png`),
    })
    if (before) return
    await page.evaluate(() => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
    })
    expect((await new AxeBuilder({ page }).include(".evidence-lightbox").analyze()).violations).toEqual([])
    await dialog.getByRole("button", { name: "Fechar imagem" }).click()
    expect((await new AxeBuilder({ page }).include(".evidence-gallery").analyze()).violations).toEqual([])
  })
}
