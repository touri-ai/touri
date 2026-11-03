import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import budgets from "./ui-budget.json" with { type: "json" }

// Keyboard users reach the hidden action by tabbing through the message; it never needs a pointer.
const tabTo = async (page: Page, message: Locator, action: Locator) => {
  await message.focus()
  for (const _ of Array.from({ length: 10 })) {
    if (await action.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  await expect(action).toBeFocused()
}

for (const width of [390, 1440]) {
  test.describe(`progressive message actions at ${width}px`, () => {
    test.use({ hasTouch: width === 390, viewport: { width, height: 844 }, reducedMotion: "reduce" })

    for (const theme of ["light", "dark"]) {
      test(`conversation stays within its control budget in ${theme}`, async ({ page }, info) => {
        await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
        await page.goto("/test/e2e/ui-budget-harness.html")
        await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Confira o plano, por favor.")
        await expect(page.getByRole("table").last()).toBeVisible()
        await page.mouse.move(0, 0)
        await page.evaluate(() => document.fonts.ready)
        const directory = process.env.MESSAGE_ACTION_EVIDENCE ?? info.outputPath("evidence")
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, `conversation-${width}-${theme}.png`), animations: "disabled" })
        const controls = await page.locator(".workspace-page").evaluate((root) =>
          Array.from(root.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select"))
            .filter((control) => {
              if (control.closest(".turn-activity, .markdown-content, [inert], [aria-hidden=true]")) return false
              if (control.matches(":disabled, .mobile-menu-button")) return false
              const bounds = control.getBoundingClientRect()
              const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
              const style = getComputedStyle(control)

              return target && control.contains(target) && style.opacity !== "0" && style.visibility !== "hidden"
            })
            .map((control) => control.getAttribute("aria-label") || control.textContent || control.tagName),
        )

        expect(controls.length, controls.join(" | ")).toBeLessThanOrEqual(budgets.conversation.maxControls)
        const message = page.locator(".message-bubble").last()
        const action = message.getByRole("button", { name: "Iniciar thread" })
        await expect(action).toHaveCSS("opacity", "0")
        if (width === 390) await message.locator(".message-body").tap()
        else await tabTo(page, message, action)
        await expect(action).toHaveCSS("opacity", "1")
        if (width === 390) await action.tap()
        else await action.press("Enter")
        await expect(page.locator(".thread-context-header")).toBeVisible()
      })
    }
  })
}
