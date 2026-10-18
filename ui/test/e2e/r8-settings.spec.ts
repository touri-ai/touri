import { expect, test } from "@playwright/test"
import { openGlobalPage, showBotAdvanced } from "./home-navigation"

const phase = process.env.R8_PHASE ?? "after"
const evidence = "../docs/qa/r8/settings"
test.use({ channel: "chromium" })
test.setTimeout(180_000)

for (const width of [1440, 1100]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${phase}: configurações ${theme} em ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
      await page.goto("/test/e2e/r8-settings-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Você Local · grátis", exact: true })).toBeVisible()
      const shot = async (view: string) => {
        await page.screenshot({ path: `${evidence}/${phase}-${view}${width === 1100 ? "-narrow" : ""}-${theme}.png` })
        if (phase === "after") {
          const overflow = await page
            .getByRole("dialog")
            .evaluate((element) => element.scrollWidth - element.clientWidth)
          expect(overflow).toBeLessThanOrEqual(1)
          const paneOverflow = await page
            .locator(".settings-pane:not([hidden]), .bot-create-content, .doctor-modal-content")
            .evaluateAll((elements) => elements.map((element) => element.scrollWidth - element.clientWidth))
          expect(paneOverflow.every((overflow) => overflow <= 1)).toBe(true)
          await expect(page.getByRole("button", { name: "Fechar diálogo" })).toBeInViewport()
        }
      }
      await showBotAdvanced(page)
      await shot("bot-general")
      if (phase === "after") {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
          .click()
        await page.getByRole("dialog").getByRole("tab", { name: "Computador", exact: true }).click()
      } else await page.getByLabel("Máquina", { exact: true }).scrollIntoViewIfNeeded()
      await shot("bot-computer")
      if (phase === "after") {
        await page.getByRole("dialog").getByRole("button", { name: "Redefinir", exact: true }).scrollIntoViewIfNeeded()
        await shot("bot-computer-maintenance")
        for (const [tab, view] of [
          ["Permissões", "bot-permissions"],
          ["Ferramentas", "bot-mcp"],
        ] as const) {
          await page.getByRole("dialog").getByRole("tab", { name: tab, exact: true }).click()
          await shot(view)
        }
      }
      if (phase === "after") {
        await page.getByRole("dialog").getByRole("tab", { name: "Rotinas", exact: true }).click()
        await expect(page.getByRole("dialog")).toHaveCount(0)
        const routines = page.getByRole("region", { name: "Rotinas", exact: true })
        await expect(routines).toBeFocused()
        expect(await routines.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        await page.screenshot({
          path: `${evidence}/${phase}-bot-routines${width === 1100 ? "-narrow" : ""}-${theme}.png`,
        })
      } else await page.getByRole("button", { name: "Fechar diálogo" }).click()
      await page.getByRole("button", { name: /Você Local/ }).click()
      await shot("preferences")
      if (phase === "after") {
        await expect(page.getByRole("dialog")).not.toContainText("LOCAL PREFERENCES")
        await page.getByText("Chat, barra lateral e atalhos").click()
        await shot("preferences-shortcuts")
        await page.getByRole("tab", { name: "Privacidade" }).click()
        await shot("preferences-privacy")
      }
      await page.getByRole("button", { name: "Fechar diálogo" }).click()
      await openGlobalPage(page, "Verificar este Mac")
      await expect(page.getByText(/3 prontos · 1 aviso · 1 falha/)).toBeVisible()
      await shot("doctor")
      await page.getByRole("button", { name: "Fechar diálogo" }).click()
      await page.getByRole("button", { name: "Criar bot", exact: true }).first().click()
      await shot("new-bot")
      if (phase === "after") {
        await page.getByLabel("Nome", { exact: true }).fill("Clara")
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
          .click()
        await page.getByLabel("Função", { exact: true }).fill("Pesquisa e planejamento")
        await page.getByLabel("Instruções do bot").fill("Pesquise com cuidado e apresente fontes em português.")
        await shot("new-bot-role")
        await page.getByRole("dialog").getByRole("button", { name: "Criar bot", exact: true }).click()
        await expect(page.getByRole("dialog")).toHaveCount(0)
        await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
      }
    })
  }
}
