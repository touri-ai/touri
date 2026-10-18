import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", timezoneId: "America/Sao_Paulo" })

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["phone", 390, 844],
] as const) {
  test(`routine sidebar: ${name} groups runs and opens history`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-sidebar-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const conversations = page.getByRole("region", { name: "Conversas de mark" })

    await expect(conversations.locator(".thread-row")).toHaveCount(2)
    await expect(conversations.locator(".thread-row").first()).toContainText("Planejamento da semana")
    await expect(conversations.locator(".thread-row").last()).toContainText("18/10/2026, 14:45")
    await expect(conversations.locator(".thread-row strong").last()).toHaveAttribute(
      "title",
      "Resumo diário · 18/10/2026, 14:45",
    )

    await conversations.getByRole("button", { name: "Histórico de rotinas" }).click()
    const history = page.locator(".routine-run-history")
    await expect(history).toHaveAttribute("open")
    await expect(history.getByRole("button", { name: "Abrir conversa" })).toHaveCount(28)
    await history.getByRole("button", { name: "Abrir conversa" }).last().click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await expect(
      page.locator(".message-assistant").getByText("Resumo pronto para conferir.", { exact: true }),
    ).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await expect(conversations.locator(".thread-row")).toHaveCount(2)
    await expect(conversations.locator(".thread-row.selected")).toContainText("18/10/2026, 08:00")
  })

  test(`routine sidebar: ${name} opens results beyond the first history page`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-sidebar-harness.html?runs=60")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await page.getByRole("button", { name: "Histórico de rotinas" }).click()
    const history = page.locator(".routine-run-history")
    await expect(history).toHaveAttribute("open")
    await expect(history.getByRole("button", { name: "Abrir conversa" })).toHaveCount(50)
    await history.getByRole("button", { name: "Carregar mais" }).click()
    await expect(history.getByRole("button", { name: "Abrir conversa" })).toHaveCount(10)
    await history.getByRole("button", { name: "Abrir conversa" }).last().click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await expect(page.locator(".thread-row.selected")).toContainText("18/10/2026, 08:00")
  })

  test(`routine sidebar: ${name} filters a routine and reaches its oldest of 128 results`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-sidebar-harness.html?runs=128&otherRoutines")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const conversations = page.getByRole("region", { name: "Conversas de mark" })
    await conversations.locator(".thread-row").filter({ hasText: "Resumo diário" }).click()
    await expect(page.locator(".message-assistant")).toContainText("Resumo pronto para conferir.")
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await conversations.getByRole("button", { name: "Histórico de rotinas" }).click()
    const history = page.locator(".routine-run-history")

    await expect(history).toHaveAttribute("open")
    await expect(history.getByRole("combobox", { name: "Filtrar histórico por rotina" })).not.toHaveValue("all")
    await expect(history.getByRole("status")).toHaveText("Execuções 1–50 de 128")
    await expect(history.getByRole("listitem")).toHaveCount(50)
    await history.locator("summary").click()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await conversations.getByRole("button", { name: "Histórico de rotinas" }).click()
    await expect(history).toHaveAttribute("open")
    await expect(history.getByRole("status")).toHaveText("Execuções 1–50 de 128")
    const directory = process.env.TOURI_ROUTINE_SIDEBAR_SHOTS_DIR
    if (directory) {
      await page.screenshot({ path: `${directory}/history-first-${name}.png`, animations: "disabled" })
    }

    await history.getByRole("button", { name: "Carregar mais" }).click()
    await expect(history.getByRole("status")).toHaveText("Execuções 51–100 de 128")
    await expect(history.getByRole("listitem")).toHaveCount(50)
    await history.getByRole("button", { name: "Carregar mais" }).click()
    await expect(history.getByRole("status")).toHaveText("Execuções 101–128 de 128")
    await expect(history.getByRole("listitem")).toHaveCount(28)
    if (directory) {
      await page.screenshot({ path: `${directory}/history-last-${name}.png`, animations: "disabled" })
    }

    await history.getByRole("button", { name: "Abrir conversa" }).last().click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await expect(page.locator(".message-assistant")).toContainText("Resumo pronto para conferir.")
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await expect(conversations.locator(".thread-row.selected")).toContainText("18/10/2026, 08:00")
  })
}
