import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium" })

const evidenceDirectory = join(tmpdir(), "touri-thread-delete-evidence")

for (const width of [1440, 390]) {
  test(`conversation actions are visible and confirm deletion at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.clock.setFixedTime(new Date("2026-10-20T12:00:00Z"))
    await page.goto("/test/e2e/thread-deletion-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu" }).click()
    const conversations = page.getByRole("region", { name: "Conversas de mark" })
    const row = conversations.locator(".thread-row").filter({ hasText: "Eventos de leads" })
    await expect(row).toBeVisible()

    const screenshot = (name: string) => page.screenshot({ path: join(evidenceDirectory, `${name}-${width}.png`) })
    await mkdir(evidenceDirectory, { recursive: true })
    await page.mouse.move(12, 12)
    await screenshot("before")
    const rowShell = row.locator("xpath=..")
    const menuButton = rowShell.getByRole("button", { name: "Ações da conversa", exact: true })
    await expect(menuButton).toBeVisible()
    await expect(menuButton).toHaveAttribute("aria-describedby", (await row.locator("strong").getAttribute("id")) ?? "")
    const target = await menuButton.boundingBox()
    const minimumTarget = width <= 800 ? 44 : 40
    expect(target?.width).toBeGreaterThanOrEqual(minimumTarget)
    expect(target?.height).toBeGreaterThanOrEqual(minimumTarget)
    await menuButton.focus()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByRole("menuitem", { name: "Arquivar conversa" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menuButton).toBeFocused()
    await menuButton.click()
    await expect(page.getByRole("menuitem", { name: "Arquivar conversa" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Apagar conversa…" })).toBeVisible()
    await screenshot("after-menu")
    await page.getByRole("menuitem", { name: "Apagar conversa…" }).click()
    const confirmation = page.getByRole("alertdialog", { name: "Apagar “Eventos de leads”?" })
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText("1 mensagem")
    await screenshot("after-confirmation")
    await confirmation.getByRole("button", { name: "Apagar", exact: true }).click()
    await expect(page.locator(".thread-delete-toast")).toContainText("Desfazer")
    await screenshot("after-undo-toast")
    await page.waitForTimeout(5100)
    await expect(row).toBeHidden()
    await screenshot("after-delete")
  })
}
