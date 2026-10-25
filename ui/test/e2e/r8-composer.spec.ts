import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"
import { showBotDetails } from "./home-navigation"

const phase = process.env.R8_CAPTURE_PHASE ?? "after"
test.setTimeout(60_000)
const evidence = process.env.TOURI_E2E_EVIDENCE_DIR ?? "../docs/qa/r8/composer"
test.use({ channel: "chromium", viewport: { width: 1440, height: 900 } })
for (const theme of ["light", "dark"] as const) {
  for (const view of phase === "before"
    ? ["idle", "draft", "narrow", "auth", "machine"]
    : ["idle", "draft", "narrow", "auth", "machine", "running", "queued"]) {
    test(`composer ${phase} ${view} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" })
      if (view === "narrow") await page.setViewportSize({ width: 1100, height: 900 })
      await page.goto(`/test/e2e/r8-composer-harness.html?view=${view}`)
      const input = page.getByRole("textbox", { name: "Mensagem para mark" })
      await expect(input).toBeVisible()
      await expect(page.getByRole("button", { name: "Painel do bot", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false",
      )
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      if (["draft", "narrow"].includes(view)) {
        await input.fill(
          "Quero organizar as prioridades da semana.\nConsidere as tarefas de pesquisa, revisão e planejamento.\nPode separar os próximos passos por dia?",
        )
        await page.locator('input[type="file"]').setInputFiles([
          { name: "prioridades.md", mimeType: "text/markdown", buffer: Buffer.from("# Prioridades") },
          {
            name: "planejamento-da-proxima-semana-com-anotacoes.csv",
            mimeType: "text/csv",
            buffer: Buffer.from("dia,tarefa"),
          },
        ])
      }
      await expect(page.locator(".message-scroll .message-bubble")).toHaveCount(
        ["running", "queued"].includes(view) ? 2 : 1,
      )
      if (phase === "after") {
        if (["draft", "narrow"].includes(view)) {
          await input.focus()
          await expect(page.locator(".chat-bot-chip [data-mascot-state]")).toHaveAttribute(
            "data-mascot-state",
            "listening",
          )
        }
        await showBotDetails(page)
        const composer = page.locator("form.composer")
        await expect(composer).toBeInViewport()
        expect(await composer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        if (["draft", "narrow"].includes(view)) {
          await expect(composer.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
          await expect(composer.locator(".attachment-chip")).toHaveCount(2)
        }
        if (["running", "queued"].includes(view))
          await expect(composer.getByRole("button", { name: "Parar", exact: true })).toBeVisible()
      }
      await page.screenshot({
        path: `${evidence}/${phase}-${view}-${theme}.png`,
        mask: [
          page.locator(".model-picker-trigger-label, .composer-login-card"),
          page.getByRole("button", { name: /^Modelo:/ }),
        ],
      })
    })
  }
}

if (phase === "after") {
  test("keyboard, height limit, attachments and advanced settings", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/r8-composer-harness.html")
    const input = page.getByRole("textbox", { name: "Mensagem para mark" })
    await expect(input).toBeVisible()
    const initial = await input.evaluate((element) => element.getBoundingClientRect().height)
    await input.fill("Primeira linha")
    await input.press("Shift+Enter")
    await input.pressSequentially("Segunda linha com acentuação")
    await expect(input).toHaveValue("Primeira linha\nSegunda linha com acentuação")
    expect(await input.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initial)
    await expect(page.locator(".chat-bot-chip [data-mascot-state]")).toHaveAttribute("data-mascot-state", "listening")
    await input.fill(Array.from({ length: 30 }, (_, index) => `Linha ${index + 1}`).join("\n"))
    expect(await input.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(190)
    await expect(input).toHaveCSS("overflow-y", "auto")
    await input.fill("Confira o plano")
    await page
      .getByLabel("Anexar arquivos", { exact: true })
      .setInputFiles({ name: "plano.md", mimeType: "text/markdown", buffer: Buffer.from("# Plano") })
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
    await input.press("Enter")
    await expect(input).toHaveValue("")
    const sent = await page.evaluate(() => {
      const api: ReturnType<typeof createMockApi> = Reflect.get(window, "r8ComposerApi")
      return api.calls.find((call) => call.route === "POST /threads/:id/messages")
    })
    expect(sent?.input.text).toBe("Confira o plano")
    expect(sent?.input.attachmentIds).toEqual(["attachment:/mock/plano.md"])
    await showBotDetails(page)
    const panel = page.getByRole("complementary", { name: "Painel de mark" })
    await expect(panel.getByRole("button", { name: /^Projeto do bot:/ })).toBeVisible()
    await panel.getByRole("button", { name: /^Escolher modelo:/ }).click()
    const modelList = page.getByRole("listbox", { name: "Modelos de Codex" })
    await expect(modelList).toBeVisible()
    await expect(modelList.getByRole("option", { name: "gpt-6.1-sol" })).toHaveAttribute("aria-selected", "true")
    await modelList.getByRole("option", { name: "gpt-6-luna" }).click()
    await expect(panel.getByRole("button", { name: "Escolher modelo: Codex · gpt-6-luna" })).toBeVisible()
    await panel.getByRole("button", { name: /^Escolher modelo:/ }).click()
    await page.getByRole("option", { name: "Outro modelo…" }).click()
    const customModel = page.getByRole("textbox", { name: "Nome do modelo" })
    await customModel.fill(" custom-model ")
    await customModel.press("Enter")
    await expect(panel.getByRole("button", { name: "Escolher modelo: Codex · custom-model" })).toBeVisible()

    await showBotDetails(page)
    await page.getByRole("button", { name: /^Modelo:/ }).click()
    const settings = page.getByRole("dialog", { name: "Configurações de mark" })
    await expect(settings).toBeVisible()
    await page.locator("#settings-model").click()
    const settingsModels = settings.getByRole("listbox", { name: "Modelos de Codex" })
    await expect(settingsModels.getByRole("option", { name: "custom-model" })).toHaveAttribute("aria-selected", "true")
    await settingsModels.getByRole("option", { name: "Padrão do provedor" }).click()
    await expect(page.getByRole("dialog", { name: "Configurações de mark" })).toBeVisible()
    await page.getByRole("button", { name: "Fechar diálogo" }).click()
    await page.getByRole("button", { name: "Ajustar permissões" }).click()
    await expect(page.getByRole("dialog", { name: "Permissões do bot" })).toBeVisible()
  })

  test("model menu supports keyboard selection and custom models at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/r8-composer-harness.html")
    await showBotDetails(page)
    const panel = page.getByRole("complementary", { name: "Painel de mark" })
    const chip = panel.getByRole("button", { name: "Escolher modelo: Codex · gpt-6.1-sol" })
    await chip.click()
    const listbox = page.getByRole("listbox", { name: "Modelos de Codex" })
    await expect(listbox).toBeVisible()
    const bounds = await listbox.evaluate((element) => {
      const rect = element.parentElement?.getBoundingClientRect()
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null
    })
    expect(bounds).not.toBeNull()
    expect(bounds?.left).toBeGreaterThanOrEqual(0)
    expect(bounds?.right).toBeLessThanOrEqual(390)
    expect(bounds?.top).toBeGreaterThanOrEqual(0)
    expect(bounds?.bottom).toBeLessThanOrEqual(844)

    const firstModel = listbox.getByRole("option", { name: "gpt-6.1-sol" })
    await firstModel.press("ArrowDown")
    const nextModel = listbox.getByRole("option", { name: "gpt-6-luna" })
    await expect(nextModel).toBeFocused()
    await nextModel.press("Enter")
    await expect(panel.getByRole("button", { name: "Escolher modelo: Codex · gpt-6-luna" })).toBeVisible()

    await panel.getByRole("button", { name: /^Escolher modelo:/ }).click()
    await page.getByRole("option", { name: "Outro modelo…" }).click()
    const custom = page.getByRole("textbox", { name: "Nome do modelo" })
    await expect(custom).toBeFocused()
    await custom.fill(" modelo-avancado ")
    await custom.press("Enter")
    await expect(panel.getByRole("button", { name: "Escolher modelo: Codex · modelo-avancado" })).toBeVisible()
  })

  for (const theme of ["light", "dark"] as const) {
    test(`composer accessible in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto("/test/e2e/r8-composer-harness.html?view=auth")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      const results = await new AxeBuilder({ page }).include(".composer-island").include(".composer-notice").analyze()
      expect(results.violations).toEqual([])
      await page.getByRole("button", { name: "Entrar no Codex nesta máquina", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "Configurações de mark" })).toBeVisible()
    })
  }
}
