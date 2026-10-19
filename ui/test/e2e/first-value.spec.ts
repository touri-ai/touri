import { expect, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"

type HarnessWindow = { createBotApi: ReturnType<typeof createMockApi>; installCli: () => void }

for (const [device, width, height] of [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
] as const) {
  test.describe(device, () => {
    test.use({ viewport: { width, height }, reducedMotion: "reduce" })

    test("truthful server landing, two-click creation, and a source-free Portuguese example", async ({ page }) => {
      await page.goto("/test/e2e/create-bot-harness.html")
      await expect(page.getByText(/O histórico fica neste servidor/)).toBeVisible()
      await expect(page.locator("body")).not.toContainText(/neste Mac|Nada sai daqui/)
      await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
      const dialog = page.getByRole("dialog")
      await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
      await expect(dialog.getByText("Usa o Codex, conectado neste servidor.")).toBeVisible()
      await expect(dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      )
      await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
      const composer = page.getByRole("textbox", { name: "Mensagem para Clara" })
      await expect(composer).toBeVisible()
      await page.getByRole("button", { name: "Usar exemplo" }).click()
      await expect(composer).toBeFocused()
      await expect(composer).toHaveValue(
        /lista em português do Brasil[\s\S]*Comprar café; revisar orçamento; marcar reunião\./,
      )
      expect(
        await page.evaluate(() =>
          (window as unknown as HarnessWindow).createBotApi.calls.filter(
            (call) => call.route === "POST /threads/:id/messages",
          ),
        ),
      ).toHaveLength(0)
      await page.getByRole("button", { name: "Enviar", exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as HarnessWindow).createBotApi.calls.filter(
                (call) => call.route === "POST /threads/:id/messages",
              ).length,
          ),
        )
        .toBe(1)
      const bot = await page.evaluate(() => (window as unknown as HarnessWindow).createBotApi.getState().bots[0])
      expect(bot?.projectId).toBeNull()
      expect(bot?.folders).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test("installation takes precedence over saved login and returning preserves the draft", async ({ page }) => {
      await page.goto("/test/e2e/create-bot-harness.html?missing-cli")
      await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByText("O Codex ainda não está instalado neste servidor.")).toBeVisible()
      await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
      await dialog.getByRole("searchbox", { name: "Buscar trabalhos" }).fill("repositório")
      await dialog.getByRole("radio", { name: "Mapa do repositório" }).click()
      await dialog.getByRole("radio", { name: "Chifres Longos" }).click()
      await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
      await expect(dialog.getByRole("alert")).toContainText("Instale a IA")
      await expect(dialog.getByText(/Usa o Codex/)).toHaveCount(0)
      await page
        .context()
        .route("https://developers.openai.com/codex/cli/", (route) =>
          route.fulfill({ contentType: "text/html", body: "Installation guide fixture" }),
        )
      const popup = page.waitForEvent("popup")
      await dialog.getByRole("link", { name: "Ver como instalar" }).click()
      const guide = await popup
      await expect(guide).toHaveURL("https://developers.openai.com/codex/cli/")
      await guide.close()
      await page.evaluate(() => (window as unknown as HarnessWindow).installCli())
      await dialog.getByRole("button", { name: "Verificar novamente" }).click()
      await expect(dialog.getByText("Usa o Codex, conectado neste servidor.")).toBeVisible()
      await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("Clara")
      await expect(dialog.getByRole("radio", { name: "Mapa do repositório" })).toBeChecked()
      await expect(dialog.getByRole("radio", { name: "Chifres Longos" })).toBeChecked()
      await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
      await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
      await expect(page.getByText(/Escolha a pasta do repositório para começar/)).toBeVisible()
      await expect(page.getByRole("button", { name: "Explique o repositório conectado." })).toHaveCount(0)
      await page.getByRole("button", { name: "Escolher pasta do repositório" }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      expect(
        await page.evaluate(() =>
          (window as unknown as HarnessWindow).createBotApi.calls.filter(
            (call) => call.route === "POST /threads/:id/messages",
          ),
        ),
      ).toHaveLength(0)
    })
  })
}
