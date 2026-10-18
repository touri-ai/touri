import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"

type OnboardingWindow = Window & { createBotApi?: ReturnType<typeof createMockApi> }

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]
viewports.forEach((viewport) => {
  test.describe(`team onboarding at ${viewport.width}px`, () => {
    test.use({ viewport, reducedMotion: "reduce" })

    test("suggests complementary work and reviews a single contextual group offer", async ({ page }) => {
      await page.goto("/test/e2e/create-bot-harness.html")
      await expect(page.locator(".team-next-step")).toHaveCount(0)
      await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
      await page.getByRole("radio", { name: "Caderno em ordem" }).check()
      await submitBot(page, "Clara")
      const suggestion = page.getByRole("region", { name: "Coloque outro bot para trabalhar com você" })

      await expect(suggestion.getByRole("listitem")).toHaveCount(3)
      await expect(suggestion.getByRole("button", { name: "Caderno em ordem" })).toHaveCount(0)
      const job = suggestion.getByRole("button", { name: "Semana com foco" })
      await job.focus()
      await page.keyboard.press("Enter")
      await expect(page.getByRole("radio", { name: "Semana com foco" })).toBeChecked()
      await expect(page.getByRole("radio", { name: "Caderno em ordem" })).toHaveAccessibleDescription(
        /Você já tem um bot cuidando disso\./,
      )
      await submitBot(page, "Bia")

      const offer = page.getByRole("button", { name: "Trabalhar em grupo com Clara?" })
      await expect(page.locator(".team-next-step")).toHaveCount(1)
      await offer.focus()
      await page.keyboard.press("Enter")
      const group = page.getByRole("dialog", { name: "Criar grupo" })
      await expect(group.getByRole("textbox", { name: "Nome do grupo" })).toHaveValue("Equipe com Bia")
      await expect(group.getByRole("textbox", { name: "Nome do grupo" })).toBeFocused()
      await expect(group.getByRole("checkbox", { name: "Clara" })).toBeChecked()
      await expect(group.getByRole("checkbox", { name: "Bia" })).toBeChecked()
      await page.keyboard.press("Enter")

      expect(await getGroupWrites(page)).toHaveLength(0)
      const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
      expect(
        accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? "")),
      ).toEqual([])
      await group.getByRole("button", { name: "Cancelar", exact: true }).click()
      await expect(group).toHaveCount(0)
      await page.keyboard.press("Control+n")
      await submitBot(page, "Davi")

      await expect(page.locator(".team-next-step")).toHaveCount(1)
      await expect(offer).toHaveCount(0)
      await page.getByRole("button", { name: "Trabalhar em grupo com Bia?" }).click()
      await expect(group.getByRole("checkbox", { name: "Bia" })).toBeChecked()
      await expect(group.getByRole("checkbox", { name: "Davi" })).toBeChecked()
      await expect(group.getByRole("checkbox", { name: "Clara" })).not.toBeChecked()
      await group.getByRole("button", { name: "Criar grupo", exact: true }).click()
      await expect(group).toHaveCount(0)

      expect(await getGroupWrites(page)).toHaveLength(1)
    })
  })
})

const submitBot = async (page: Page, name: string) => {
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Nome", { exact: true }).fill(name)
  await expect(dialog.getByText(/conectado neste/)).toBeVisible()
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByRole("textbox", { name: `Mensagem para ${name}` })).toBeVisible()
  await expect(dialog).toHaveCount(0)
}

const getGroupWrites = (page: Page) =>
  page.evaluate(() => {
    const onboardingWindow: OnboardingWindow = window

    return onboardingWindow.createBotApi?.calls.filter((call) => call.route === "POST /groups") ?? []
  })
