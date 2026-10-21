import { expect, test } from "@playwright/test"

test.describe("phone layout review", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "pt-BR",
    reducedMotion: "reduce",
  })

  test("approval notice and composer keep touch controls reachable", async ({ page }) => {
    await page.goto("/test/e2e/approval-notice-harness.html")

    const notice = page.locator(".approval-notice")
    const review = notice.getByRole("button", { name: "Revisar", exact: true })
    const dismiss = notice.getByRole("button", { name: "Dispensar aviso", exact: true })
    for (const control of [review, dismiss]) {
      const bounds = await control.boundingBox()
      expect(bounds).not.toBeNull()
      if (!bounds) throw new Error("Missing approval notice control")
      expect(bounds.width).toBeGreaterThanOrEqual(44)
      expect(bounds.height).toBeGreaterThanOrEqual(44)
    }

    await page.goto("/test/e2e/home-harness.html?scenario=long-composer")

    const composer = page.locator(".composer-island")
    const textarea = composer.locator("textarea")
    const textBounds = await textarea.boundingBox()
    expect(textBounds).not.toBeNull()
    if (!textBounds) throw new Error("Missing composer input")
    expect(textBounds.height).toBeGreaterThanOrEqual(44)
    const controlSelectors = [
      ".composer-tools-left",
      ".model-picker-trigger.composer-model",
      ".composer-project",
      ".composer-actions",
    ]
    const controlCenters = await Promise.all(
      controlSelectors.map((selector) =>
        composer.locator(selector).evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          return bounds.top + bounds.height / 2
        }),
      ),
    )
    expect(Math.max(...controlCenters) - Math.min(...controlCenters)).toBeLessThanOrEqual(4)
    const bounds = await Promise.all(
      [".model-picker-trigger.composer-model", ".composer-project-chip", ".composer-actions"].map((selector) =>
        composer.locator(selector).boundingBox(),
      ),
    )
    const [model, project, actions] = bounds
    if (!model || !project || !actions) throw new Error("Missing composer selection bounds")

    expect(model.x + model.width).toBeLessThanOrEqual(project.x)
    expect(project.x + project.width).toBeLessThanOrEqual(actions.x)
  })

  test("wrapped approval status starts at the tool card content edge", async ({ page }) => {
    await page.goto("/test/e2e/approval-harness.html?scene=read")

    const card = page.locator(".tool-call-card").first()
    const header = card.locator(".tool-card-header")
    const status = header.locator(".tool-status-chip")
    const headerBounds = await header.boundingBox()
    const statusBounds = await status.boundingBox()
    expect(headerBounds).not.toBeNull()
    expect(statusBounds).not.toBeNull()
    if (!headerBounds || !statusBounds) throw new Error("Missing tool card status")
    expect(Math.abs(statusBounds.x - headerBounds.x)).toBeLessThanOrEqual(1)
  })

  test("file approval shows one useful explanation when file details are missing", async ({ page }) => {
    await page.goto("/test/e2e/approval-harness.html?scene=unknown")

    await expect(
      page.getByText("O provedor não informou quais arquivos serão consultados.", { exact: true }),
    ).toHaveCount(1)
    await expect(page.locator(".tool-approval-unknown")).toHaveCount(0)
  })
})
