import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 } })

test("chat exposes quick model and project controls and remembers the panel choice", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/r8-composer-harness.html")
  const input = page.getByRole("textbox", { name: "Mensagem para mark" })
  await expect(input).toBeVisible()
  const composer = page.getByRole("form", { name: "Compor mensagem" })
  const supportsDictation = await page.evaluate(
    () =>
      window.isSecureContext &&
      typeof (Reflect.get(window, "SpeechRecognition") ?? Reflect.get(window, "webkitSpeechRecognition")) ===
        "function",
  )
  await expect(composer.locator("button")).toHaveCount(supportsDictation ? 5 : 4)
  if (supportsDictation)
    await expect(composer.getByRole("button", { name: "Ditar mensagem", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  await expect(composer.getByRole("button", { name: "Anexar arquivo", exact: true })).toBeVisible()
  await expect(composer.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled()
  const model = composer.getByRole("button", { name: /^Escolher modelo:/ })
  await expect(model).toHaveAttribute("aria-label", /^Escolher modelo: .+ · .+/)
  await expect(model).toHaveText(/.+ · .+/)
  await expect(composer.getByRole("button", { name: /^Projeto do bot:/ })).toBeVisible()
  await expect(composer.locator(".composer-shield")).toHaveCount(0)
  const toggle = page.getByRole("button", { name: "Painel do bot", exact: true })
  const panel = page.getByRole("complementary", { name: "Painel de mark" })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(panel).toBeHidden()
  await toggle.click()
  await expect(page.getByRole("tab", { name: "Detalhes", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(
    panel.getByText(
      "Pede permissão antes de mudar arquivos; alterações ficam na pasta do bot, no projeto e nas pastas liberadas.",
    ),
  ).toBeVisible()
  await expect(panel.getByRole("button", { name: "Modelo: Codex · gpt-6.1-sol" })).toBeVisible()
  await expect(panel.getByText("Trabalha neste servidor.")).toBeVisible()
  const results = await new AxeBuilder({ page }).include(".bot-workspace").analyze()
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([])
  await page.reload()
  await expect(panel).toBeVisible()
  await page.getByRole("button", { name: "Fechar painel do bot" }).click()
  await expect(toggle).toBeFocused()
  await page.reload()
  await expect(panel).toBeHidden()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
})

test("failed replies keep error codes inside the error disclosure", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/r8-composer-harness.html?view=machine")
  const error = page.getByRole("alert").first()
  await expect(error).toBeVisible()
  const code = error.locator("code")
  await expect(code).toHaveText(/TOURI-E\d{4}/)
  await expect(code).toBeHidden()
  await error.getByText("Detalhes do erro", { exact: true }).click()
  await expect(code).toBeVisible()
  await expect(page.getByRole("button", { name: "Painel do bot", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
})
