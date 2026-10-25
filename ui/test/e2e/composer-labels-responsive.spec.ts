import { expect, test } from "@playwright/test"

const modelLabel = "Escolher modelo: Modelos por API · modelo-ficticio-de-planejamento-com-contexto-extenso-2026-10"

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`keeps long settings accessible outside the composer at ${width} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.goto("/test/e2e/home-harness.html?scenario=long-composer")
      const composer = page.getByRole("form", { name: "Compor mensagem" })
      await expect(composer.getByRole("button", { name: /^Escolher modelo:/ })).toHaveCount(0)
      await expect(composer.getByRole("button", { name: /^Projeto do bot:/ })).toHaveCount(0)
      await composer.getByRole("textbox").fill("Revisar o plano fictício.")
      await expect(composer.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
      await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
      await page.getByRole("button", { name: "Ajustar", exact: true }).click()
      const model = page.getByRole("button", { name: modelLabel })
      const project = page.getByRole("button", {
        name: "Projeto do bot: Projeto fictício de planejamento e acessibilidade",
      })
      for (const control of [model, project]) {
        await expect(control).toBeVisible()
        await expect(control).toBeInViewport()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await project.click()
      await expect(page.getByRole("menu", { name: "Projeto do bot", exact: true })).toBeVisible()
    })
  }
}
