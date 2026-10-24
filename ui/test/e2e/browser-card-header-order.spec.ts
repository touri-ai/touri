import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const unavailable = "Esta sessão do navegador está indisponível."

// Where a sticky header belongs: at the card's top edge, or, once that edge scrolled past the history's
// padded top, right there.
const getHeaderSpot = (page: Page) =>
  page.locator(".browser-activity-card").evaluate((card) => {
    const header = card.querySelector(".browser-activity-header")?.getBoundingClientRect()
    const box = card.getBoundingClientRect()
    const scroll = document.querySelector<HTMLElement>(".message-scroll")
    const outcome = card.querySelector('[role="alert"]')?.getBoundingClientRect()
    if (!header || !scroll) throw new Error("card not laid out")
    const stuck = scroll.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(scroll).paddingTop)
    return {
      inPlace: Math.abs(header.top - Math.max(box.top, stuck)) <= 2,
      beforeOutcome: outcome ? header.bottom <= outcome.top + 1 : true,
    }
  })

const headerFirst = { inPlace: true, beforeOutcome: true }

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])
  for (const history of ["short", "long"] as const)
    test(`browser card keeps its header first in a ${history} conversation at ${viewport.width}px`, async ({
      page,
    }) => {
      test.setTimeout(60_000)
      await page.setViewportSize(viewport)
      await page.goto(`/test/e2e/browser-outcome-harness.html?${history === "long" ? "long=1" : ""}`)
      const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
      await expect(input).toBeVisible({ timeout: 30_000 })
      await input.fill("Rascunho que deve continuar aqui")
      const takeOver = page.locator(".browser-activity-card").getByRole("button", { name: "Assumir", exact: true })
      await expect(takeOver).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => getHeaderSpot(page)).toMatchObject(headerFirst)

      // The protected refusal is revealed in place; the header still leads the card, without the test scrolling.
      await takeOver.dispatchEvent("click")
      const outcome = page.getByRole("alert").filter({ hasText: unavailable })
      await expect(outcome).toHaveCount(1)
      await expect(page.locator(".browser-activity-recovery-return")).toBeVisible()
      if (process.env.TOURI_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.TOURI_SCREENSHOT_DIR}/card-header-${history}-${viewport.width}.png`,
        })
      await expect.poll(() => getHeaderSpot(page)).toMatchObject(headerFirst)

      // Reading further down the card, the header still sticks to the top of the history.
      // In a long history the revealed refusal leaves room below, so the card's top can pass the header's spot.
      const passed = await page.locator(".message-scroll").evaluate((list) => {
        const card = list.querySelector(".browser-activity-card")
        if (!card) return false
        const spot = list.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(list).paddingTop)
        list.scrollBy(0, Math.ceil(card.getBoundingClientRect().top - spot) + 40)
        return card.getBoundingClientRect().top < spot - 1
      })
      if (history === "long") expect(passed).toBe(true)
      await expect.poll(async () => (await getHeaderSpot(page)).inPlace).toBe(true)

      await page.locator(".browser-activity-recovery-return").dispatchEvent("click")
      await expect(outcome).toHaveCount(0)
      await expect(input).toHaveValue("Rascunho que deve continuar aqui")
    })
