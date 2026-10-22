import { expect, type Locator, test } from "@playwright/test"

// Use actual pointer down/up at text and icon descendants. DOM-dispatched clicks
// bypass hit testing and cannot detect an overlay intercepting these controls.
const pointerClick = async (target: Locator): Promise<void> => {
  await target.scrollIntoViewIfNeeded()
  const page = target.page()
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit === element || (hit !== null && element.contains(hit))
      }),
    )
    .toBe(true)
  const box = await target.boundingBox()
  if (!box) throw new Error("Missing click target")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(100)
  await page.mouse.up()
}

test("title bars leave bot rows, header actions and top-bar controls clickable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/r8-sidebar-harness.html?menus")
  await expect(page.getByRole("textbox", { name: "Mensagem para touri-qa" })).toBeVisible()
  await page.getByRole("tab", { name: /^Bots/ }).click()
  await expect(page.locator(".traffic-light-row")).toHaveAttribute("data-tauri-drag-region", "deep")
  await expect(page.locator(".chat-header")).toHaveAttribute("data-tauri-drag-region", "deep")
  await pointerClick(page.locator('[data-bot-entry="sidebar-bot-3"] .bot-row-main strong'))
  await expect(page.getByRole("textbox", { name: "Mensagem para touri-coder" })).toBeVisible()
  await pointerClick(page.locator('[data-bot-entry="sidebar-bot-2"] .bot-row-main .tb-avatar'))
  await expect(page.getByRole("textbox", { name: "Mensagem para touri-qa" })).toBeVisible()
  const panelToggle = page.locator(".chat-header .bot-panel-toggle")
  const expanded = await panelToggle.getAttribute("aria-expanded")
  await pointerClick(panelToggle)
  await expect(panelToggle).not.toHaveAttribute("aria-expanded", expanded ?? "false")
  await pointerClick(panelToggle)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await pointerClick(page.getByRole("button", { name: /^Planejamento/ }))
  await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
  await expect(page.locator(".group-header")).toHaveAttribute("data-tauri-drag-region", "deep")
  await pointerClick(page.locator(".group-header").getByRole("button", { name: /^Membros do canal:/ }))
  await pointerClick(
    page
      .getByRole("complementary", { name: "Painel do canal Planejamento", exact: true })
      .getByRole("button", { name: "Editar canal", exact: true }),
  )
  const dialog = page.getByRole("dialog", { name: "Editar canal" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Fechar canal" }).click()
  await expect(dialog).not.toBeVisible()
  await pointerClick(page.locator('.sidebar-top-actions button[aria-label="Buscar conversas"] svg'))
  await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toBeVisible()
})
