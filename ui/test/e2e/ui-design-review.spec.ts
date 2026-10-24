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

    await page.getByRole("button", { name: "Abrir menu" }).click()
    const review = page.locator(".sidebar-needs-you")
    for (const control of [review]) {
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
    await expect(composer.getByRole("button", { name: /^Escolher modelo:/ })).toHaveCount(0)
    await expect(composer.getByRole("button", { name: /^Projeto do bot:/ })).toHaveCount(0)
    const attach = composer.getByRole("button", { name: "Anexar arquivo", exact: true })
    const send = composer.getByRole("button", { name: "Enviar", exact: true })
    const [attachment, actions] = await Promise.all([attach.boundingBox(), send.boundingBox()])
    if (!attachment || !actions) throw new Error("Missing composer controls")
    expect(attachment.x + attachment.width).toBeLessThanOrEqual(actions.x)
    expect(Math.abs(attachment.y + attachment.height / 2 - actions.y - actions.height / 2)).toBeLessThanOrEqual(4)
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
