import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  test(`phone composer shows complete selected values in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
    await page.goto("/test/e2e/home-harness.html?scenario=long-composer")
    const model = page.getByRole("button", { name: "Escolher modelo: Codex · atlas-planning-experimental-2026-10" })
    const project = page.getByRole("button", {
      name: "Projeto do bot: Projeto fictício de planejamento e acessibilidade",
    })
    const send = page.getByRole("button", { name: "Enviar", exact: true })

    for (const control of [model, project]) {
      await expect(control).toBeVisible()
      const text = control.locator(".composer-model-name")
      expect(await text.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal")
      expect(await text.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const labelBounds = await control.boundingBox()
      const sendBounds = await send.boundingBox()
      expect(labelBounds && sendBounds && labelBounds.x + labelBounds.width <= sendBounds.x).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Revisar o plano fictício.")
    await expect(send).toBeEnabled()
    await expect(send).toBeInViewport()
    await project.click()
    await expect(page.getByRole("menu", { name: "Projeto do bot", exact: true })).toBeVisible()
  })
}
