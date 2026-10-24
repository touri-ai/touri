import { expect, type Locator, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

// Inside the conversation's own visible area and on top: not clipped by the history, not covered.
const getPlacement = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const list = document.querySelector(".message-scroll")?.getBoundingClientRect()
    return {
      withinHistory: list ? box.top >= list.top - 1 && box.bottom <= list.bottom + 1 : false,
      hittable: [box.top + 1, box.bottom - 1].every((y) => {
        const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2), y)
        return hit !== null && element.contains(hit)
      }),
    }
  })

for (const history of ["short", "long"] as const)
  test(`active take-over keeps its handback reachable after resizing to a phone (${history} conversation)`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/test/e2e/browser-outcome-harness.html?takeover=live${history === "long" ? "&long=1" : ""}`)
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill("Rascunho que deve continuar aqui")
    await page
      .locator(".browser-activity-card")
      .getByRole("button", { name: "Assumir", exact: true })
      .dispatchEvent("click")

    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(view.getByRole("img")).toBeVisible({ timeout: 20_000 })
    const handback = view.getByRole("button", { name: "Devolver para mark", exact: true })
    await page.waitForTimeout(300)
    expect(await getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })

    // The same session moves to a phone-sized window; nothing in the test scrolls the history.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/takeover-resized-${history}-390.png` })
    expect(await getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })

    // Focusing the keyboard entry on the phone must not hide the handback either.
    await view.getByRole("button", { name: "Digitar no navegador" }).dispatchEvent("click")
    await page.waitForTimeout(300)
    expect(await getPlacement(handback)).toEqual({ withinHistory: true, hittable: true })

    await handback.dispatchEvent("click")
    await expect(view).toHaveCount(0)
    expect(
      await page.evaluate(
        () => (window as Window & { browserOutcome?: { releases: string[] } }).browserOutcome?.releases,
      ),
    ).toEqual(["browser-outcome-tab"])
    await expect(input).toHaveValue("Rascunho que deve continuar aqui")
  })
