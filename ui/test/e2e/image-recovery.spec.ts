import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const before = process.env.IMAGE_RECOVERY_PHASE === "before"
test.use({ channel: "chromium", reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  for (const state of ["denied", "persisted"]) {
    test(`image recovery ${state} at ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/test/e2e/image-recovery-harness.html?state=${state}`)
      if (!before && state === "persisted") {
        await expect(page.getByRole("img", { name: "Arte de exemplo" })).toBeVisible()
        const box = await page.locator(".evidence-thumbnail").boundingBox()
        expect(box && Math.abs(box.width / box.height - 2)).toBeLessThan(0.05)
      } else if (!before) {
        await expect(page.getByText("Imagem fora da pasta do bot", { exact: true })).toBeVisible()
        await expect(page.getByRole("button", { name: "Tentar novamente" })).toHaveCount(0)
        await expect(page.getByText("/outside/result.png", { exact: true })).toBeVisible()
      } else {
        await expect(page.locator(".evidence-thumbnail span")).not.toHaveText("Carregando imagem…")
      }
      const directory = process.env.IMAGE_RECOVERY_EVIDENCE_DIR
      if (directory) await mkdir(directory, { recursive: true })
      const getCapturePath = (name: string) => (directory ? join(directory, name) : testInfo.outputPath(name))
      await page.screenshot({ path: getCapturePath(`${before ? "before" : "after"}-${state}-${width}.png`) })
      await page.getByRole("button", { name: /Abrir captura/ }).click()
      const dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      if (!before && state === "denied") {
        await expect(dialog.getByText("Imagem fora da pasta do bot", { exact: true })).toBeVisible()
        await expect(dialog.getByRole("navigation")).toHaveCount(0)
      } else if (!before) await expect(dialog.getByRole("img")).toBeVisible()
      await page.screenshot({
        path: getCapturePath(`${before ? "before" : "after"}-viewer-${state}-${width}.png`),
      })
    })
  }
}
