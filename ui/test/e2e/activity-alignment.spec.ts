import { mkdir } from "node:fs/promises"
import { expect, type Page, type TestInfo, test } from "@playwright/test"

const evidenceDirectory = process.env.ACTIVITY_ALIGNMENT_EVIDENCE_DIR
const desktopViewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "window", width: 1024, height: 700 },
]
const phoneViewport = { name: "phone", width: 390, height: 844 }
const conversations = ["dm", "channel"] as const

const checkPermissionActivity = async (
  page: Page,
  conversation: (typeof conversations)[number],
  theme: string,
  viewport: { name: string; width: number; height: number },
  testInfo: TestInfo,
): Promise<void> => {
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/test/e2e/approval-harness.html?scene=read&conversation=${conversation}`)
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value
  }, theme)

  const activity = page.locator(".activity-mark")
  const message = page.locator(`[data-conversation="${conversation}"] .message-bubble`)
  const avatar = activity.locator(".activity-mascot .tb-avatar")
  const chevron = activity.locator(".turn-activity-chevron")
  const label = activity.locator(".activity-label")
  await expect(activity).toBeVisible()
  await expect(message).toBeVisible()
  if (conversation === "channel") await expect(message.locator(".message-role")).toContainText("Bot de teste do canal")
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
  const activityStyles = await activity.evaluate((node) => {
    const labelLink = node.querySelector(".activity-approval-link")
    const chevronIcon = node.querySelector(".turn-activity-chevron")
    if (!labelLink || !chevronIcon) throw new Error("Missing permission activity controls")
    const chevronBounds = chevronIcon.getBoundingClientRect()
    const toggleBounds = chevronIcon.parentElement?.getBoundingClientRect()
    if (!toggleBounds) throw new Error("Missing permission activity toggle")

    return {
      ink: getComputedStyle(node).color,
      link: getComputedStyle(labelLink).color,
      chevron: { width: chevronBounds.width, height: chevronBounds.height },
      target: { width: toggleBounds.width, height: toggleBounds.height },
    }
  })
  const targetSize = viewport.name === "phone" ? 44 : 24
  expect(activityStyles.link).toBe(activityStyles.ink)
  expect(activityStyles.chevron).toEqual({ width: 16, height: 16 })
  expect(activityStyles.target.width).toBeGreaterThanOrEqual(targetSize)
  expect(activityStyles.target.height).toBeGreaterThanOrEqual(targetSize)
  const filename = `activity-${conversation}-${theme}-${viewport.name}.png`
  const screenshot = evidenceDirectory ? `${evidenceDirectory}/${filename}` : testInfo.outputPath(filename)
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })
  await page.screenshot({ path: screenshot, animations: "disabled" })
  await testInfo.attach(`activity-${conversation}-${theme}-${viewport.name}`, {
    path: screenshot,
    contentType: "image/png",
  })
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
}

for (const theme of ["dark", "light"])
  for (const conversation of conversations)
    for (const viewport of desktopViewports)
      test(`permission activity aligns in ${conversation}, ${theme}, ${viewport.width}px`, async ({
        page,
      }, testInfo) => {
        await checkPermissionActivity(page, conversation, theme, viewport, testInfo)
      })

test.describe("permission activity on a phone", () => {
  test.use({ viewport: { width: phoneViewport.width, height: phoneViewport.height }, isMobile: true, hasTouch: true })

  for (const theme of ["dark", "light"])
    for (const conversation of conversations)
      test(`permission activity aligns in ${conversation}, ${theme}`, async ({ page }, testInfo) => {
        await checkPermissionActivity(page, conversation, theme, phoneViewport, testInfo)
      })
})
