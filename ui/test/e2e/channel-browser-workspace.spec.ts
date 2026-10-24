import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } })

for (const scenario of [
  { viewer: "person-requester", controller: "", canControl: true, canStop: true },
  { viewer: "owner", controller: "", canControl: true, canStop: true },
  { viewer: "person-observer", controller: "", canControl: false, canStop: false },
  { viewer: "owner", controller: "owner", canControl: true, canStop: false },
  { viewer: "person-requester", controller: "owner", canControl: false, canStop: false },
]) {
  test(`workspace browser presentation for ${scenario.viewer}, controller=${scenario.controller}`, async ({ page }) => {
    await page.goto(
      `/test/e2e/channel-browser-workspace-harness.html?viewer=${scenario.viewer}&controller=${scenario.controller}`,
    )
    await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.getByRole("button", { name: /^Viagens/ }).click()

    const header = scenario.controller
      ? "Léo no navegador · pedido de Ana · Carla está no controle"
      : "Léo no navegador · pedido de Ana"
    await expect(page.getByRole("status", { name: header })).toBeVisible()
    const card = page.getByRole("article", { name: "Navegador do Léo" })
    await expect(card.getByRole("button", { name: "Assumir", exact: true })).toHaveCount(scenario.canControl ? 1 : 0)
    const status = page.locator(".composer-browser-status")
    await expect(status.getByRole("button", { name: "Parar Léo" })).toHaveCount(scenario.canStop ? 1 : 0)
    await expect(status.getByRole("button", { name: "Assumir", exact: true })).toHaveCount(scenario.canControl ? 1 : 0)
    await expect(page.getByRole("textbox", { name: "Mensagem para Viagens" })).toBeEnabled()
  })
}

for (const focusedStop of [true, false]) {
  test(`browser completion preserves keyboard focus, focused Stop=${focusedStop}`, async ({ page }) => {
    await page.goto("/test/e2e/channel-browser-workspace-harness.html?viewer=person-requester")
    await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.getByRole("button", { name: /^Viagens/ }).click()
    const stop = page.getByRole("button", { name: "Parar Léo" })
    await expect(stop).toBeVisible()
    const attachment = page.getByRole("button", { name: "Anexar arquivo", exact: true })
    const initialFocus = focusedStop ? stop : attachment
    await stop.focus()
    await initialFocus.focus()

    await page.evaluate(() => window.dispatchEvent(new Event("fixture:browser-finished")))

    await expect(page.locator(".composer-browser-status")).toHaveCount(0)
    await expect(stop).toHaveCount(0)
    const expectedFocus = focusedStop ? page.getByRole("textbox", { name: "Mensagem para Viagens" }) : attachment
    await expect(expectedFocus).toBeFocused()
  })
}

test("activating browser Stop returns focus before cancellation completes", async ({ page }) => {
  await page.goto("/test/e2e/channel-browser-workspace-harness.html?viewer=person-requester")
  await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("button", { name: /^Viagens/ }).click()
  const stop = page.getByRole("button", { name: "Parar Léo" })
  await stop.focus()

  await page.keyboard.press("Enter")

  await expect(page.getByRole("textbox", { name: "Mensagem para Viagens" })).toBeFocused()

  await page.evaluate(() => window.dispatchEvent(new Event("fixture:browser-finished")))

  await expect(stop).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Mensagem para Viagens" })).toBeFocused()
})

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`controller context stays readable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.goto("/test/e2e/channel-browser-workspace-harness.html?viewer=person-requester&controller=owner")
      await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible({ timeout: 15_000 })
      if (width === 390) await page.locator(".mobile-menu-button").click()
      await page.getByRole("tab", { name: /^Work,/ }).click()
      await page.getByRole("button", { name: /^Viagens/ }).click()

      const context = page.getByRole("status", {
        name: "Léo no navegador · pedido de Ana · Carla está no controle",
      })
      await expect(context).toBeVisible()
      const fitsViewport = await context.evaluate((element) => {
        const bounds = element.getBoundingClientRect()

        return element.scrollWidth <= element.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth
      })
      expect(fitsViewport).toBe(true)
      const accessibility = await new AxeBuilder({ page })
        .include(".channel-chip")
        .include(".browser-activity-card")
        .include(".composer-browser-status")
        .analyze()
      expect(accessibility.violations).toEqual([])
    })
  }
}
