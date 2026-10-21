import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const evidenceDirectory = process.env.ACTIVITY_ALIGNMENT_EVIDENCE_DIR
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "window", width: 1024, height: 700 },
  { name: "phone", width: 390, height: 844 },
]

// ChatPanel renders VirtualMessageList for both direct and group conversations.
for (const theme of ["dark", "light"])
  for (const viewport of viewports)
    test(`permission activity aligns in ${theme} at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto("/test/e2e/approval-harness.html?scene=read")
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)

      const activity = page.locator(".activity-mark")
      const avatar = activity.locator(".activity-mascot .tb-avatar")
      const chevron = activity.locator(".turn-activity-chevron")
      const label = activity.locator(".activity-label")
      await expect(activity).toBeVisible()
      await expect(label).toContainText("Preciso da sua autorização.")
      await expect(chevron).toBeVisible()
      await page.evaluate(() => document.fonts.ready)

      const centers = await Promise.all(
        [avatar, chevron, label].map((element) =>
          element.evaluate((node) => {
            const bounds = node.getBoundingClientRect()
            return bounds.top + bounds.height / 2
          }),
        ),
      )
      const filename = `activity-${theme}-${viewport.name}.png`
      const screenshot = evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename)
      if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })
      await page.screenshot({ path: screenshot, animations: "disabled" })
      await testInfo.attach(`activity-${theme}-${viewport.name}`, { path: screenshot, contentType: "image/png" })
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
    })
