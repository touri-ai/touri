import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const phase = process.env.R8_CAPTURE_PHASE ?? "after"
test.setTimeout(60_000)
const evidence = "../docs/qa/r8/composer"
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
      if (view === "narrow") await page.getByRole("button", { name: "Fechar painel do bot" }).click()
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
        const composer = page.getByRole("form", { name: "Compor mensagem" })
        await expect(composer).toBeInViewport()
        expect(await composer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        if (["draft", "narrow"].includes(view)) {
          await expect(composer.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
          await expect(composer.locator(".attachment-chip")).toHaveCount(2)
          await expect(page.locator(".chat-bot-chip [data-mascot-state]")).toHaveAttribute(
            "data-mascot-state",
            "listening",
          )
        }
        if (["running", "queued"].includes(view))
          await expect(composer.getByRole("button", { name: "Parar", exact: true })).toBeVisible()
      }
      await page.screenshot({ path: `${evidence}/${phase}-${view}-${theme}.png` })
    })
  }
}

if (phase === "after") {
  test("keyboard, height limit, attachments, existing settings and access tooltip", async ({ page }) => {
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
    const sent = await page.evaluate(() =>
      (
        window as unknown as {
          r8ComposerApi: { calls: Array<{ route: string; input: { text?: string; attachmentIds?: Array<string> } }> }
        }
      ).r8ComposerApi.calls.find((call) => call.route === "POST /threads/:id/messages"),
    )
    expect(sent?.input.text).toBe("Confira o plano")
    expect(sent?.input.attachmentIds).toEqual(["attachment:/mock/plano.md"])
    await page.getByRole("button", { name: /Escolher modelo: Codex/ }).click()
    await expect(page.getByRole("dialog", { name: "Escolher modelo" })).toBeVisible()
    await expect(page.getByText(/O Codex não disponibiliza uma lista de modelos no touri/)).toBeVisible()
    await page.getByRole("button", { name: "Fechar diálogo" }).click()
    const shield = page.getByRole("button", { name: "Permissões do bot: Escrita no projeto" })
    await shield.focus()
    await expect(page.getByRole("tooltip")).toBeVisible()
    await expect(page.getByRole("tooltip")).toContainText("Escrita no projeto")
    await shield.click()
    await expect(page.getByRole("dialog", { name: "Permissões do bot" })).toBeVisible()
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
