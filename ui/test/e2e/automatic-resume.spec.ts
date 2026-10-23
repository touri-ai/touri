import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(60_000)
const viewports = [1440, 390].flatMap((width) => ["dark", "light"].map((theme) => ({ width, theme })))
viewports.forEach(({ width, theme }) => {
  test(`automatic recovery keeps one card and hides manual recovery at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    const captureDirectory = process.env.AUTOMATIC_RESUME_CAPTURE_DIR
    if (captureDirectory) await mkdir(captureDirectory, { recursive: true })
    const getCapturePath = (name: string) =>
      captureDirectory ? join(captureDirectory, name) : testInfo.outputPath(name)
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/test/e2e/automatic-resume-harness.html?phase=before&theme=${theme}`)
    await expect(page.getByRole("alert")).toBeVisible()
    await page.screenshot({ path: getCapturePath(`before-${width}-${theme}.png`), fullPage: true })

    await page.goto(`/test/e2e/automatic-resume-harness.html?phase=after&theme=${theme}`)
    await expect(page.getByText("Retomando automaticamente…", { exact: true })).toHaveAttribute("role", "status")
    await expect(page.getByRole("button", { name: "Parar", exact: true })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Retomar tarefa" })).toHaveCount(0)
    await expect(page.locator('.message-bubble[data-message-id="partial"]')).toHaveCount(1)
    await page.screenshot({ path: getCapturePath(`after-${width}-${theme}.png`), fullPage: true })
  })

  test(`channel continuation stays in the original card at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    const captureDirectory = process.env.AUTOMATIC_RESUME_CAPTURE_DIR
    if (captureDirectory) await mkdir(captureDirectory, { recursive: true })
    await page.setViewportSize({ width, height: 844 })

    await page.goto(`/test/e2e/automatic-resume-harness.html?view=channel&theme=${theme}`)

    await expect(page.getByText("Retomado após falha do provedor", { exact: true })).toHaveCount(0)
    await expect(page.locator('.message-bubble[data-message-id="partial"]')).toContainText(
      "Relatório concluído com os totais conferidos.",
    )
    await expect(page.locator('.message-bubble[data-message-id="channel-answer"]')).toHaveCount(0)
    const filename = `channel-after-${width}-${theme}.png`
    await page.screenshot({
      path: captureDirectory ? join(captureDirectory, filename) : testInfo.outputPath(filename),
      fullPage: true,
    })
  })
})
