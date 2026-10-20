import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", timezoneId: "America/Sao_Paulo" })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-18T18:00:00-03:00"))
})

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["phone", 390, 844],
] as const) {
  test(`routine sidebar: ${name} clears grouped unread runs with one click`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-sidebar-harness.html?unread")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const conversations = page.getByRole("region", { name: "Conversas de mark" })
    const routine = conversations.getByRole("button", { name: /Resumo diário/ })
    const directory = process.env.TOURI_ROUTINE_SIDEBAR_SHOTS_DIR

    await expect(routine.locator(".sidebar-unread")).toHaveText("8")
    if (directory) await page.screenshot({ path: `${directory}/unread-group-${name}.png`, animations: "disabled" })
    await routine.click()
    await expect(page.locator(".message-assistant")).toContainText("Resumo pronto para conferir.")
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await expect(routine.locator(".sidebar-unread")).toHaveCount(0)
    await expect(page.locator(".thread-row.selected")).toContainText("14:45")
    if (directory) await page.screenshot({ path: `${directory}/read-group-${name}.png`, animations: "disabled" })
  })

  test(`routine sidebar: ${name} groups deleted routine conversations and keeps old results reachable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-sidebar-harness.html?deleted&unread&runs=128")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const conversations = page.getByRole("region", { name: "Conversas de mark" })
    const routine = conversations.getByRole("button", { name: /Rotina excluída/ })

    await expect(conversations.locator(".thread-row")).toHaveCount(2)
    await expect(conversations.getByRole("button", { name: "Histórico de rotinas" })).toHaveCount(0)
    await expect(routine.locator(".sidebar-unread")).toHaveText("8")
    await routine.click()
    await expect(page.locator(".message-assistant")).toContainText("Resumo pronto para conferir.")
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await expect(routine.locator(".sidebar-unread")).toHaveCount(0)
    const toggle = conversations.getByRole("button", { name: "Conversas de rotinas excluídas" })
    await toggle.click()
    const history = page.getByRole("region", { name: "Conversas de rotinas excluídas" })

    await expect(history.locator(".thread-row")).toHaveCount(50)
    await history.getByRole("button", { name: "Próxima página" }).click()
    await expect(history.getByRole("status")).toHaveText("Execuções 51–100 de 128")
    await history.getByRole("button", { name: "Próxima página" }).click()
    await expect(history.locator(".thread-row")).toHaveCount(28)
    await expect(history.getByRole("status")).toHaveText("Execuções 101–128 de 128")
    await history.getByRole("button", { name: "Página anterior" }).click()
    await history.getByRole("button", { name: "Página anterior" }).click()
    const oldest = history.getByRole("button", { name: /18\/10\/2026, 08:00/ })

    await oldest.click()
    await expect(page.locator(".message-assistant")).toContainText("Resumo pronto para conferir.")
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(conversations.locator(".thread-row")).toHaveCount(2)
    await expect(page.locator(".thread-row.selected")).toContainText("08:00")
    const directory = process.env.TOURI_ROUTINE_SIDEBAR_SHOTS_DIR
    if (directory) await page.screenshot({ path: `${directory}/deleted-group-${name}.png`, animations: "disabled" })
  })

  test(`routine sidebar: ${name} groups runs and opens history`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/routine-sidebar-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const conversations = page.getByRole("region", { name: "Conversas de mark" })

    await expect(conversations.locator(".thread-row")).toHaveCount(2)
    await expect(conversations.locator(".thread-row").first()).toContainText("Planejamento da semana")
    await expect(conversations.locator(".thread-row").last()).toContainText("hoje · 14:45")
    await expect(conversations.locator(".thread-row strong").last()).toHaveAttribute(
      "title",
      "Rotina Resumo diário · 18/10/2026, 14:45",
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
    await expect(conversations.locator(".thread-row.selected")).toContainText("hoje · 08:00")
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
    await history.getByRole("button", { name: "Próxima página" }).click()
    await expect(history.getByRole("button", { name: "Abrir conversa" })).toHaveCount(10)
    await history.getByRole("button", { name: "Abrir conversa" }).last().click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await expect(page.locator(".thread-row.selected")).toContainText("hoje · 08:00")
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

    await history.getByRole("button", { name: "Próxima página" }).click()
    await expect(history.getByRole("status")).toHaveText("Execuções 51–100 de 128")
    await expect(history.getByRole("listitem")).toHaveCount(50)
    await history.getByRole("button", { name: "Próxima página" }).click()
    await expect(history.getByRole("status")).toHaveText("Execuções 101–128 de 128")
    await expect(history.getByRole("listitem")).toHaveCount(28)
    if (directory) {
      await page.screenshot({ path: `${directory}/history-last-${name}.png`, animations: "disabled" })
    }

    await history.getByRole("button", { name: "Abrir conversa" }).last().click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await expect(page.locator(".message-assistant")).toContainText("Resumo pronto para conferir.")
    if (name === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await expect(conversations.locator(".thread-row.selected")).toContainText("hoje · 08:00")
  })
}
