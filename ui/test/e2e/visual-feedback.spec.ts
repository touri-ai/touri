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
            await expect(avatar.locator(".tb-avatar-contour")).toBeVisible()
            await expect(avatar.locator(".tb-avatar-contour")).toHaveCSS("animation-name", "none")
          }
          await expect(page.locator(".tb-avatar-rings, linearGradient")).toHaveCount(0)
        }
      } else if (phase === "after") {
        const centers = await page.locator(".tb-avatar").evaluateAll((nodes) =>
          nodes.map((node) => {
            const tile = node.getBoundingClientRect()
            const body = node.querySelector(".tb-avatar-body g path")?.getBoundingClientRect()
            return body
              ? {
                  dx: body.x + body.width / 2 - tile.x - tile.width / 2,
                  dy: body.y + body.height / 2 - tile.y - tile.height / 2,
                }
              : null
          }),
        )
        for (const center of centers) {
          expect(center).not.toBeNull()
          expect(Math.abs(center?.dx ?? Infinity)).toBeLessThan(0.5)
          expect(Math.abs(center?.dy ?? Infinity)).toBeLessThan(0.5)
        }
      }
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: `${evidence}/${phase}-${view}-${theme}.png`, fullPage: true })
    })
  }
}

if (phase === "after") {
  test("working contour pulses in all four surfaces and becomes static under reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto("/test/e2e/fixtures/visual-feedback.html?view=working&theme=dark")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await expect(page.locator(".bot-panel")).toHaveCount(0)
    await showBotPanel(page)
    for (const selector of [".bot-row.selected", ".chat-bot-chip", ".bot-panel-identity", ".activity-mascot"]) {
      const avatar = page.locator(`${selector} .tb-avatar`).first()
      const contour = avatar.locator(".tb-avatar-contour")
      await expect(contour).toHaveCSS("animation-name", "avatar-contour-pulse")
      await expect(contour).toHaveCSS("animation-duration", "1.2s")
      await expect(contour).toHaveCSS("stroke", "rgb(59, 147, 240)")
      expect(
        await avatar.evaluate(
          (element) =>
            element.querySelector(".tb-avatar-contour")?.getAttribute("d") ===
            element.querySelector(".tb-avatar-body g path")?.getAttribute("d"),
        ),
      ).toBe(true)
    }
    await expect(page.locator(".tb-avatar-rings, linearGradient")).toHaveCount(0)
    await expect(page.locator(".bot-panel-identity .tb-avatar")).toHaveAttribute("data-avatar-state", "idle")
    await page.evaluate(async () => {
      const finite = document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      const settle = (animation: Animation): Promise<unknown> =>
        Promise.race([animation.finished.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))])
      await Promise.all(finite.map(settle))
      for (const animation of document.getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === "avatar-contour-pulse") {
          animation.currentTime = 600
          animation.pause()
        }
      }
    })
    await page.screenshot({ path: `${evidence}/after-working-motion-dark.png` })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".bot-panel-identity .tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
    const body = await page.locator(".bot-panel-identity .tb-avatar-body").innerHTML()
    for (const contour of await page.locator(".tb-avatar-contour").all())
      await expect(contour).toHaveCSS("animation-name", "none")
    await page.clock.install()
    await page.clock.runFor(2400)
    expect(await page.locator(".bot-panel-identity .tb-avatar-body").innerHTML()).toBe(body)
  })
}
