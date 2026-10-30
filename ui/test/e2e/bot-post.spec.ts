import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })

const cases = [1440, 390].flatMap((width) => ["before", "after"].map((phase) => ({ width, phase })))
cases.forEach(({ width, phase }) => {
  test(`bot posts show the channel sender ${phase} at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto(`/test/e2e/bot-post-harness.html?phase=${phase}`)
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.getByRole("button", { name: /Atlas/ }).first().click()
    const message = page.locator('[data-message-id="notice"]')
    await expect(message).toBeVisible()

    if (phase === "before") await expect(message).toHaveClass(/message-user/)
    if (phase === "after") {
      await expect(message.locator(".message-role")).toHaveText("Atlas")
      await expect(message.locator('[data-bot-id="bot-mark"]')).toBeVisible()
      await expect(message).not.toHaveClass(/message-user/)
      await expect(message.getByText("Você", { exact: true })).toHaveCount(0)
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          localStorage.setItem("touri.appearance.v1", theme)
          window.dispatchEvent(new Event("touri:appearance"))
        }, theme)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const audit = await new AxeBuilder({ page }).include('[data-message-id="notice"]').analyze()

        expect(audit.violations).toEqual([])
      }
    }

    await expect(message.getByRole("img", { name: /Membro excluído/ })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.evaluate(() => document.fonts.ready)
    const image = await page.screenshot({ animations: "disabled" })
    const filename = `bot-post-${phase}-${width}.png`
    await writeFile(info.outputPath(filename), image)
    if (!process.env.TOURI_E2E_EVIDENCE_DIR) return

    await mkdir(process.env.TOURI_E2E_EVIDENCE_DIR, { recursive: true })
    await writeFile(join(process.env.TOURI_E2E_EVIDENCE_DIR, filename), image)
  })
})
