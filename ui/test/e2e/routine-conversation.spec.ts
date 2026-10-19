import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", timezoneId: "UTC" })
test.setTimeout(60_000)

for (const [name, width, height, theme] of [
  ["desktop-light", 1440, 900, "light"],
  ["desktop-dark", 1440, 900, "dark"],
  ["phone-light", 390, 844, "light"],
  ["phone-dark", 390, 844, "dark"],
] as const) {
  test(`routine sidebar preview hides the no-news marker · ${name}`, async ({ page }) => {
    const phone = width === 390
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
    await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
    await page.goto("/?mockScenario=routine-conversation")

    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (phone) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const preview = page.locator('[data-bot-entry="bot-mark"] .bot-preview')
    await expect(preview).toHaveText("Sem novidades nesta execução")
    await expect(preview).not.toContainText("NO_NOTIFICATION")
    await expect(preview).toHaveAttribute("title", "Sem novidades nesta execução")
    if (phone) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
  })
}

const appearances = ["dark", "light", "mobile", "expanded"]

for (const appearance of appearances) {
  test(`routine conversation: ${appearance}`, async ({ page }, testInfo) => {
    const mobile = appearance === "mobile"
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: 1000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript(
      (theme) => localStorage.setItem("touri.appearance.v1", theme),
      appearance === "light" ? "light" : "dark",
    )

    await page.goto("/?mockScenario=routine-conversation")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    const instructions = page.getByRole("button", { name: "Instruções da rotina", exact: true })
    const prompt = page.getByText(
      "Confira as mensagens recebidas desde a última execução e procure apenas assuntos que precisam de atenção hoje.",
      { exact: true },
    )
    const schedule = page.getByRole("button", { name: "Agendar esta tarefa", exact: true })

    await expect(instructions).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(".message-routine-prompt .disclosure-reveal")).toHaveAttribute("aria-hidden", "true")
    await expect(page.getByText("Sem novidades nesta execução", { exact: true })).toBeVisible()
    await expect(page.getByText("NO_NOTIFICATION", { exact: true })).toHaveCount(0)
    await expect(schedule).toHaveCount(0)
    await expect(page.locator(".routine-run-marker")).toContainText("Resumo da caixa de entrada")
    await expect(page.locator(".routine-run-marker")).toContainText("Concluído")
    await expect(page.locator(".routine-run-marker time")).toHaveText("16:04")
    if (!mobile) await expect(page.locator(".thread-row.selected strong")).toHaveText("Resumo da caixa de entrada")

    const marker = await page.locator(".routine-run-marker").boundingBox()
    const answer = await page.locator(".message-assistant").boundingBox()
    const routinePrompt = await page.locator(".message-routine-prompt").boundingBox()
    expect(marker).not.toBeNull()
    expect(answer).not.toBeNull()
    expect(routinePrompt).not.toBeNull()
    expect(Math.abs((marker?.x ?? 0) - (answer?.x ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((marker?.width ?? 0) - (answer?.width ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((routinePrompt?.x ?? 0) - (answer?.x ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((routinePrompt?.width ?? 0) - (answer?.width ?? 0))).toBeLessThanOrEqual(1)
    expect(
      await page.locator(".message-scroll").evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1)

    if (appearance === "expanded") {
      await instructions.focus()
      await instructions.press("Enter")
      await expect(instructions).toHaveAttribute("aria-expanded", "true")
      await expect(prompt).toBeVisible()
    }

    await page.screenshot({
      path: process.env.TOURI_ROUTINE_SHOTS_DIR
        ? `${process.env.TOURI_ROUTINE_SHOTS_DIR}/after-${appearance}.png`
        : testInfo.outputPath(`after-${appearance}.png`),
      animations: "disabled",
    })
  })
}
