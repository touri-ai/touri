import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { showBotPanel } from "./home-navigation"

test.use({ channel: "chrome" })
const phase = process.env.VISUAL_CAPTURE_PHASE === "before" ? "before" : "after"
const evidence = resolve(import.meta.dirname, "../../../docs/qa/visual")
mkdirSync(evidence, { recursive: true })

for (const theme of ["light", "dark"]) {
  for (const view of ["terminal", "idle", "working", "shapes"]) {
    test(`${phase} ${view} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(`/test/e2e/fixtures/visual-feedback.html?view=${view}&theme=${theme}`)
      if (view === "terminal") {
        await expect(page.locator(".tool-card")).toHaveCount(2)
        await page.locator("details").evaluateAll((details) => {
          for (const detail of details) detail.setAttribute("open", "")
        })
        if (phase === "after") {
          await expect(page.locator('.tool-input code[data-highlighted="true"]')).toHaveCount(2)
          await expect(page.locator('.tool-technical code[data-highlighted="true"]')).toHaveCount(2)
          await expect(page.locator('[data-call-id="empty"] .tool-output code')).toHaveText("Sem saída")
          await expect(page.locator('[data-call-id="colors"] .tool-output code')).toHaveText(
            "✓ Diretório criado\n./docs/qa/result.txt\nAviso: exemplo de saída\nErro: exemplo de mensagem",
          )
        }
      } else if (view !== "shapes") {
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        await expect(page.locator(".bot-panel")).toHaveCount(0)
        await showBotPanel(page)
        await expect(page.locator(".bot-panel-identity .tb-avatar")).toBeVisible()
        if (phase === "after" && view === "working") {
          for (const selector of [".bot-row.selected", ".chat-bot-chip", ".bot-panel-identity", ".activity-mascot"]) {
            const avatar = page.locator(`${selector} .tb-avatar`).first()
            await expect(avatar).toHaveAttribute("data-avatar-phase", /^(thinking|working)$/)
            await expect(avatar.locator(".tb-avatar-head")).toHaveCSS("animation-name", "none")
          }
          await expect(page.locator(".tb-avatar-rings, linearGradient")).toHaveCount(0)
        }
      } else if (phase === "after") {
        const offsets = await page.locator(".tb-avatar").evaluateAll((nodes) =>
          nodes.map((node) => {
            const tile = node.getBoundingClientRect()
            const body = node.querySelector(".tb-avatar-body")?.getBoundingClientRect()
            return body ? Math.abs(body.x - tile.x) + Math.abs(body.width - tile.width) : Infinity
          }),
        )
        for (const offset of offsets) expect(offset).toBeLessThan(0.5)
      }
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: `${evidence}/${phase}-${view}-${theme}.png`, fullPage: true })
    })
  }
}

if (phase === "after") {
  test("working bull animates in every live surface and becomes still under reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto("/test/e2e/fixtures/visual-feedback.html?view=working&theme=dark")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await expect(page.locator(".bot-panel")).toHaveCount(0)
    await showBotPanel(page)
    for (const selector of [".bot-row.selected", ".chat-bot-chip", ".bot-panel-identity"]) {
      const head = page.locator(`${selector} .tb-avatar .tb-avatar-head`).first()
      await expect(head).toHaveCSS("animation-name", /^tb-avatar-(bob|tilt)$/)
    }
    await expect(page.locator(".activity-mascot .tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
    await expect(page.locator(".tb-avatar-rings, linearGradient")).toHaveCount(0)
    await page.screenshot({ path: `${evidence}/after-working-motion-dark.png`, animations: "disabled" })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".bot-panel-identity .tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
    const still = await page.locator(".bot-panel-identity .tb-avatar-body").innerHTML()
    await page.clock.install()
    await page.clock.runFor(2400)
    expect(await page.locator(".bot-panel-identity .tb-avatar-body").innerHTML()).toBe(still)
  })
}
