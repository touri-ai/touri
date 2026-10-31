import { expect, type Locator } from "@playwright/test"
import { test } from "./production-fixture"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const unavailable = "Esta sessão do navegador está indisponível."

// Inside the history's visible area and on top: the composer or a sticky header must not cover it.
const getPlacement = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const list = document.querySelector(".message-scroll")?.getBoundingClientRect()
    const rows = [box.top + 1, box.bottom - 1]
    return {
      withinHistory: list ? box.top >= list.top - 1 && box.bottom <= list.bottom + 1 : false,
      hittable: rows.every((y) => {
        const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
        return hit !== null && element.contains(hit)
      }),
    }
  })

const variants = [
  { name: "held tab from the card in a long conversation", query: "held=1&long=1", via: "card" },
  { name: "card button in a long conversation", query: "long=1", via: "card" },
  { name: "composer strip in a long conversation", query: "long=1", via: "strip" },
  { name: "held tab from the card after a restart", query: "held=1", via: "card" },
  { name: "composer strip while streaming", query: "", via: "strip" },
] as const

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
])
  for (const variant of variants)
    test(`unavailable take-over outcome stays in view: ${variant.name} at ${viewport.width}px`, async ({ page }) => {
      test.setTimeout(60_000)
      await page.setViewportSize(viewport)
      await page.goto(`/test/e2e/browser-outcome-harness.html?${variant.query}`)
      const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
      await expect(input).toBeVisible({ timeout: 20_000 })
      await input.fill("Rascunho que deve continuar aqui")
      const trigger =
        variant.via === "strip"
          ? page.locator(".composer-browser-takeover")
          : page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
      await expect(trigger).toBeVisible({ timeout: 20_000 })
      // A person taps what is on screen; dispatching the click keeps the test from scrolling the history.
      await trigger.dispatchEvent("click")

      const outcome = page.getByRole("alert").filter({ hasText: unavailable })
      await expect(outcome).toHaveCount(1)
      const handback = page.locator(".browser-activity-recovery-return")
      for (const element of [outcome, handback])
        await expect.poll(() => getPlacement(element)).toEqual({ withinHistory: true, hittable: true })
      if (process.env.TOURI_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.TOURI_SCREENSHOT_DIR}/${variant.via}-${variant.query.replace(/[=&]/g, "") || "streaming"}-${viewport.width}.png`,
        })

      await handback.dispatchEvent("click")
      await expect(outcome).toHaveCount(0)
      await expect(input).toHaveValue("Rascunho que deve continuar aqui")
    })
